use zed_extension_api::{
    self as zed, serde_json, DebugAdapterBinary, DebugTaskDefinition, Os,
    StartDebuggingRequestArguments, StartDebuggingRequestArgumentsRequest, Worktree,
};

const ADAPTER_NAME: &str = "Android";
/// npm keeps global bin shims next to `node_modules/<package>` on Windows;
/// see https://docs.npmjs.com/cli/v11/configuring-npm/folders/
const CLI_PACKAGE: &str = "zed-android-tools";
const CLI_ENTRY_PARTS: [&str; 2] = ["node_modules", "bin/zed-android.cjs"];

struct AndroidExtension;

impl zed::Extension for AndroidExtension {
    fn new() -> Self {
        Self
    }

    fn get_dap_binary(
        &mut self,
        adapter_name: String,
        config: DebugTaskDefinition,
        user_provided_debug_adapter_path: Option<String>,
        worktree: &Worktree,
    ) -> Result<DebugAdapterBinary, String> {
        if adapter_name != ADAPTER_NAME {
            return Err(format!(
                "unknown debug adapter `{adapter_name}`; expected `{ADAPTER_NAME}`"
            ));
        }
        let request = request_kind_from_json(&config.config)?;
        let request_args = StartDebuggingRequestArguments {
            configuration: config.config.clone(),
            request,
        };

        if let Some(path) = user_provided_debug_adapter_path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
        {
            return Ok(DebugAdapterBinary {
                command: Some(path),
                arguments: Vec::new(),
                envs: worktree.shell_env(),
                cwd: Some(worktree.root_path()),
                connection: None,
                request_args,
            });
        }

        let node = worktree.which("node").ok_or_else(installation_hint)?;
        let entry = resolve_cli_entry(worktree)?;
        Ok(DebugAdapterBinary {
            command: Some(node),
            arguments: vec![entry, "dap".to_string()],
            envs: worktree.shell_env(),
            cwd: Some(worktree.root_path()),
            connection: None,
            request_args,
        })
    }

    fn dap_request_kind(
        &mut self,
        adapter_name: String,
        config: serde_json::Value,
    ) -> Result<StartDebuggingRequestArgumentsRequest, String> {
        if adapter_name != ADAPTER_NAME {
            return Err(format!(
                "unknown debug adapter `{adapter_name}`; expected `{ADAPTER_NAME}`"
            ));
        }
        request_kind_from_value(&config)
    }
}

fn installation_hint() -> String {
    "the zed-android CLI was not found on PATH. From the `tools/` directory of the \
     zed-android extension run `npm ci` and `npm link`, then verify with `zed-android --help` \
     in a Zed terminal (PATH of the shell Zed inherits must include the npm global bin directory)."
        .to_string()
}

fn request_kind_from_json(raw: &str) -> Result<StartDebuggingRequestArgumentsRequest, String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("Android debug configuration is not valid JSON: {e}"))?;
    request_kind_from_value(&value)
}

fn request_kind_from_value(
    config: &serde_json::Value,
) -> Result<StartDebuggingRequestArgumentsRequest, String> {
    match config.get("request").and_then(|v| v.as_str()) {
        Some("launch") => Ok(StartDebuggingRequestArgumentsRequest::Launch),
        Some(other) => Err(format!(
            "Android debug adapter only supports request \"launch\", got \"{other}\""
        )),
        None => Err(format!(
            "Android debug configuration must set \"request\" to \"launch\""
        )),
    }
}

/// Locates the `zed-android` CLI entry point from PATH shims, using host path
/// rules (the extension runs under WASI where `Path` cannot split backslashes).
fn resolve_cli_entry(worktree: &Worktree) -> Result<String, String> {
    let (os, _) = zed::current_platform();
    if os == Os::Windows {
        // npm on Windows writes `<prefix>\zed-android.cmd` (+ .ps1) and keeps the
        // package payload at `<prefix>\node_modules\zed-android-tools\...`.
        for shim in ["zed-android.cmd", "zed-android.ps1"] {
            if let Some(shim_path) = worktree.which(shim) {
                let dir = host_parent_dir(&shim_path).ok_or_else(|| {
                    format!("could not derive a directory from the found shim `{shim_path}`")
                })?;
                return Ok(host_join(
                    dir,
                    &[CLI_ENTRY_PARTS[0], CLI_PACKAGE, &CLI_ENTRY_PARTS[1]],
                ));
            }
        }
    } else if let Some(link) = worktree.which("zed-android") {
        // npm links the bin entry to `bin/zed-android.cjs`; node executes it directly.
        return Ok(link);
    }
    Err(installation_hint())
}

fn host_parent_dir(path: &str) -> Option<&str> {
    let index = path.rfind(['/', '\\'])?;
    if index == 0 {
        // A drive-less root ("/usr") has no usable parent for our purposes.
        return None;
    }
    Some(&path[..index])
}

/// Joins host path segments without going through `std::path` (WASI would treat
/// `C:\Users\...` as one opaque component).
fn host_join(dir: &str, parts: &[&str]) -> String {
    let sep = if dir.contains('\\') || dir.contains(":\\") {
        '\\'
    } else {
        '/'
    };
    let mut result = dir.trim_end_matches(['/', '\\']).to_string();
    for part in parts {
        result.push(sep);
        result.push_str(&part.replace('/', &sep.to_string()));
    }
    result
}

zed::register_extension!(AndroidExtension);
