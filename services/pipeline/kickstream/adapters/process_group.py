"""Processes that must not outlive this one.

A browser does not exit when the program that started it dies. On Windows a job object ends
its processes when the last handle to it closes, which the system does when this process dies
for any reason. Elsewhere the processes are ended only when `close` is called.
"""

import contextlib
import os
import signal
import sys

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _KILL_ON_JOB_CLOSE = 0x2000
    _EXTENDED_LIMIT_INFORMATION = 9
    _SET_QUOTA_AND_TERMINATE = 0x0100 | 0x0001

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits),
            ("IoInfo", ctypes.c_uint64 * 6),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    _kernel.OpenProcess.restype = wintypes.HANDLE
    _kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]


class KillOnExit:
    """Ends every process added to it when closed and, on Windows, when this process dies."""

    def __init__(self) -> None:
        self._pids: list[int] = []
        self._job = None
        if sys.platform == "win32":
            self._job = _kernel.CreateJobObjectW(None, None)
            limits = _ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
            _kernel.SetInformationJobObject(
                self._job, _EXTENDED_LIMIT_INFORMATION, ctypes.byref(limits), ctypes.sizeof(limits)
            )

    def add(self, pid: int) -> None:
        self._pids.append(pid)
        if self._job:
            handle = _kernel.OpenProcess(_SET_QUOTA_AND_TERMINATE, False, pid)
            if handle:
                _kernel.AssignProcessToJobObject(self._job, handle)
                _kernel.CloseHandle(handle)

    def close(self) -> None:
        if self._job:
            _kernel.TerminateJobObject(self._job, 1)
            _kernel.CloseHandle(self._job)
            self._job = None
        elif sys.platform != "win32":
            for pid in self._pids:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGKILL)
        self._pids = []
