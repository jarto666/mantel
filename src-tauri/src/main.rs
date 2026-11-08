// No console window, dev builds included: they log to mantel.log instead.
#![windows_subsystem = "windows"]

fn main() {
    // Mantel asking Windows for permission starts itself elevated to do just that one thing; the
    // argument after the flag is Mantel's window, to hand the foreground back to.
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|a| a == mantel_lib::DEVELOPER_MODE_ARG) {
        let window = args.get(at + 1).and_then(|w| w.parse().ok()).unwrap_or(0);
        std::process::exit(mantel_lib::turn_on_developer_mode(window));
    }
    mantel_lib::run()
}
