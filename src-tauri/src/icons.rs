//! A program's icon as a picture: the 256-pixel one most programs ship, saved as a PNG for the
//! Apps tab.

use std::path::Path;

/// Saves the icon at `index` in `source` (an exe, dll or ico) to `out`. False when there's
/// none to take.
#[cfg(windows)]
pub fn extract(source: &str, index: i32, out: &Path) -> bool {
    use windows_sys::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO};

    const SIZE: i32 = 256;
    let wide: Vec<u16> = source.encode_utf16().chain(Some(0)).collect();
    let mut icon: HICON = std::ptr::null_mut();
    let mut id = 0u32;
    let got = unsafe { PrivateExtractIconsW(wide.as_ptr(), index, SIZE, SIZE, &mut icon, &mut id, 1, 0) };
    if got == 0 || got == u32::MAX || icon.is_null() {
        return false;
    }
    let mut info: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(icon, &mut info) } == 0 {
        unsafe { DestroyIcon(icon) };
        return false;
    }
    let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: SIZE,
        // Negative: rows top to bottom, as PNG wants them.
        biHeight: -SIZE,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..unsafe { std::mem::zeroed() }
    };
    let mut bgra = vec![0u8; (SIZE * SIZE * 4) as usize];
    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    let lines = unsafe { GetDIBits(dc, info.hbmColor, 0, SIZE as u32, bgra.as_mut_ptr().cast(), &mut bmi, DIB_RGB_COLORS) };
    unsafe {
        ReleaseDC(std::ptr::null_mut(), dc);
        DeleteObject(info.hbmColor);
        DeleteObject(info.hbmMask);
        DestroyIcon(icon);
    }
    if lines == 0 {
        return false;
    }
    let mut rgba = bgra;
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    // Old icons carry no alpha at all: everything reads as transparent. Show them opaque.
    if rgba.chunks_exact(4).all(|px| px[3] == 0) {
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    save_png(&rgba, SIZE as u32, out)
}

#[cfg(not(windows))]
pub fn extract(_source: &str, _index: i32, _out: &Path) -> bool {
    false
}

#[cfg_attr(not(windows), allow(dead_code))]
fn save_png(rgba: &[u8], size: u32, out: &Path) -> bool {
    let Some(dir) = out.parent() else { return false };
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let Ok(file) = std::fs::File::create(out) else { return false };
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), size, size);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let written = encoder.write_header().and_then(|mut w| w.write_image_data(rgba)).is_ok();
    if !written {
        let _ = std::fs::remove_file(out);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_png() {
        let out = std::env::temp_dir().join(format!("mantel-icon-{}.png", std::process::id()));
        let rgba: Vec<u8> = (0..4 * 4 * 4).map(|i| i as u8).collect();
        assert!(save_png(&rgba, 4, &out));
        assert_eq!(&std::fs::read(&out).unwrap()[1..4], b"PNG");
        std::fs::remove_file(&out).ok();
    }
}
