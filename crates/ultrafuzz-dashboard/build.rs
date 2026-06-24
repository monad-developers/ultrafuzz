use std::{
    env, fs,
    path::{Path, PathBuf},
};

const FALLBACK_INDEX: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ultrafuzz Dashboard</title>
<script type="module" crossorigin src="/dashboard/assets/dashboard.js"></script>
<link rel="stylesheet" crossorigin href="/dashboard/assets/index.css">
</head>
<body>
<main class="dashboard-missing">
<h1>Ultrafuzz Dashboard</h1>
<p>The React dashboard assets have not been built for this binary.</p>
</main>
</body>
</html>
"#;

const FALLBACK_JS: &str = r#"console.warn("Ultrafuzz dashboard frontend assets were not built.");
"#;

const FALLBACK_CSS: &str = r#"body {
  margin: 0;
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #162033;
  background: #f3f5f8;
}

.dashboard-missing {
  max-width: 720px;
  margin: 80px auto;
  padding: 0 24px;
}
"#;

fn main() {
    println!("cargo:rerun-if-changed=frontend/dist");
    println!("cargo:rerun-if-changed=frontend/dist/index.html");
    println!("cargo:rerun-if-changed=frontend/dist/assets/dashboard.js");
    println!("cargo:rerun-if-changed=frontend/dist/assets/index.css");
    println!("cargo:rerun-if-env-changed=ULTRAFUZZ_DASHBOARD_REQUIRE_ASSETS");

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let dist_dir = manifest_dir.join("frontend/dist");
    let index = dist_dir.join("index.html");
    let js = dist_dir.join("assets/dashboard.js");
    let css = dist_dir.join("assets/index.css");
    let has_dist = index.is_file() && js.is_file() && css.is_file();

    if !has_dist
        && matches!(
            env::var("ULTRAFUZZ_DASHBOARD_REQUIRE_ASSETS").as_deref(),
            Ok("1")
        )
    {
        panic!("dashboard frontend assets are missing; run `make dashboard-frontend` first");
    }

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    if has_dist {
        copy_asset(&index, &out_dir.join("dashboard-index.html"));
        copy_asset(&js, &out_dir.join("dashboard.js"));
        copy_asset(&css, &out_dir.join("dashboard.css"));
    } else {
        write_asset(&out_dir.join("dashboard-index.html"), FALLBACK_INDEX);
        write_asset(&out_dir.join("dashboard.js"), FALLBACK_JS);
        write_asset(&out_dir.join("dashboard.css"), FALLBACK_CSS);
    }

    fs::write(
        out_dir.join("dashboard_assets.rs"),
        r#"pub const DASHBOARD_INDEX: &str = include_str!(concat!(env!("OUT_DIR"), "/dashboard-index.html"));
pub const DASHBOARD_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/dashboard.js"));
pub const DASHBOARD_CSS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/dashboard.css"));
"#,
    )
    .unwrap();
}

fn copy_asset(source: &Path, destination: &Path) {
    fs::copy(source, destination).unwrap();
}

fn write_asset(destination: &Path, contents: &str) {
    fs::write(destination, contents).unwrap();
}
