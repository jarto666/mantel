// No console window, dev builds included: they log to mantel.log instead.
#![windows_subsystem = "windows"]

fn main() {
    // Mantel asking Windows for permission starts itself elevated to do just that one thing.
    if std::env::args().any(|a| a == mantel_lib::DEVELOPER_MODE_ARG) {
        std::process::exit(mantel_lib::turn_on_developer_mode());
    }
    mantel_lib::run()
}
