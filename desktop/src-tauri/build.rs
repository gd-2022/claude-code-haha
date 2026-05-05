fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::{env, path::PathBuf, process::Command};

        let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
        let object_path = out_dir.join("macos_notifications.o");
        let source_path = PathBuf::from("src/macos_notifications.m");

        println!("cargo:rerun-if-changed={}", source_path.display());

        let status = Command::new("clang")
            .args([
                "-fobjc-arc",
                "-c",
                source_path
                    .to_str()
                    .expect("notification bridge path is UTF-8"),
                "-o",
                object_path
                    .to_str()
                    .expect("compiled notification bridge path is UTF-8"),
            ])
            .status()
            .expect("failed to invoke clang for macOS notification bridge");

        if !status.success() {
            panic!("failed to compile macOS notification bridge");
        }

        println!("cargo:rustc-link-arg={}", object_path.display());
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
    }

    tauri_build::build()
}
