fn main() {
    // 编译共享 proto 契约(Base(Zenoh) 用)。默认引用兄弟仓库,可用 ROBOT_PROTO_DIR 覆盖。
    if std::env::var_os("PROTOC").is_none() {
        if let Ok(p) = protoc_bin_vendored::protoc_bin_path() {
            std::env::set_var("PROTOC", p);
        }
    }
    let proto_dir = std::env::var("ROBOT_PROTO_DIR")
        .unwrap_or_else(|_| "../../hex-robot-proto/proto".to_string());
    let files = ["common.proto", "controller.proto", "robot.proto", "base.proto", "arm.proto"];
    let paths: Vec<String> = files.iter().map(|f| format!("{proto_dir}/{f}")).collect();
    prost_build::compile_protos(&paths, &[&proto_dir]).expect("compile protos");
    for p in &paths {
        println!("cargo:rerun-if-changed={p}");
    }

    tauri_build::build()
}
