// No console window, dev builds included: they log to mantel.log instead.
#![windows_subsystem = "windows"]

fn main() {
    mantel_lib::run()
}
