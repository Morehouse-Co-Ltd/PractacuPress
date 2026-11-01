//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// hiddenWindow keeps the child API and security service from opening their own
// console window; their output goes to files under the data directory instead.
func hiddenWindow() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}

// childJob groups the child processes in a job object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
//
// Closing the console window already terminates everything attached to it, but a
// force quit from Task Manager, a crash or an update would leave the API running
// without a site to serve. The job closes that gap: when the launcher's last handle
// goes away, Windows kills the children.
type childJob struct {
	handle windows.Handle
}

func newChildJob() *childJob {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(handle)
		return nil
	}
	return &childJob{handle: handle}
}

// assign puts a started process into the job. A failure is not fatal: the child
// still works, it just loses the belt-and-braces cleanup.
func (j *childJob) assign(process *os.Process) {
	if j == nil || process == nil {
		return
	}
	handle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(process.Pid),
	)
	if err != nil {
		return
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	_ = windows.AssignProcessToJobObject(j.handle, handle)
}
