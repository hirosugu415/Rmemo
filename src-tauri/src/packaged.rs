//! Running as an MSIX package (the Microsoft Store build).
//!
//! A packaged app can't start at sign-in through the registry `Run` key the
//! autostart plugin writes (the write lands in the package's private hive), and
//! a startup task can't pass `--minimized`. So when packaged, autostart goes
//! through the manifest's `StartupTask` instead, and a launch *by* that task is
//! what means "start hidden in the tray". Unpackaged (the setup.exe build),
//! none of this is used.

use windows::core::HSTRING;
use windows::ApplicationModel::Activation::ActivationKind;
use windows::ApplicationModel::{AppInstance, StartupTask, StartupTaskState};

/// Must match `TaskId` in `msix/AppxManifest.xml`.
const STARTUP_TASK_ID: &str = "RmemoStartup";

/// True inside an MSIX package.
pub fn is_packaged() -> bool {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut len = 0u32;
    // Unpackaged processes get APPMODEL_ERROR_NO_PACKAGE; packaged ones are
    // told the (empty) buffer is too small for their name.
    unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) == ERROR_INSUFFICIENT_BUFFER }
}

/// True when Windows started this process through the startup task.
pub fn launched_by_startup_task() -> bool {
    AppInstance::GetActivatedEventArgs()
        .and_then(|args| args.Kind())
        .map(|kind| kind == ActivationKind::StartupTask)
        .unwrap_or(false)
}

pub fn set_startup_task(wanted: bool) -> Result<(), String> {
    let run = || -> windows::core::Result<()> {
        let task = StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID))?.get()?;
        let state = task.State()?;
        let enabled = matches!(state, StartupTaskState::Enabled | StartupTaskState::EnabledByPolicy);
        if wanted && !enabled {
            // Refused silently when the user turned it off in Task Manager —
            // their choice there wins over the app's setting.
            task.RequestEnableAsync()?.get()?;
        } else if !wanted && enabled {
            task.Disable()?;
        }
        Ok(())
    };
    run().map_err(|e| format!("could not change the startup task: {e}"))
}
