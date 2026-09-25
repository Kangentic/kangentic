// Kangentic's build of node-pty's macOS spawn-helper.
//
// node-pty (MIT License, Copyright (c) Microsoft Corporation) posix_spawns this
// helper for every PTY on macOS with argv = [helper, cwd, file, ...args]. The
// helper attaches the pty as its controlling terminal, changes directory, and
// execs the target. Everything outside the kangentic blocks is upstream's
// src/unix/spawn-helper.cc verbatim; tests/unit/spawn-helper-upstream-parity.test.ts
// strips the blocks and fails if the rest drifts from the node-pty we install.
//
// The added call clears the task-level mach exception ports before exec. On
// macOS those ports survive posix_spawn and exec, so without it every process
// an agent starts from a Kangentic PTY inherits Crashpad's port and writes its
// crashes into Kangentic's crash database (Sentry DESKTOP-K, -N, -Q, -1D).
// With no task-level port the kernel falls through to the host-level handler,
// ReportCrash, exactly as for a process started from Terminal.app. The return
// value is ignored on purpose: if the kernel refuses, the child still execs and
// behaves as it did before this helper existed.
//
// build/install-spawn-helper.js compiles this over node-pty's prebuilt helper at
// package time and proves the reset with build/spawn-helper/exception-port-probe.c.

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
// kangentic:begin exception-port-reset
#include <mach/mach.h>
// kangentic:end

int main (int argc, char** argv) {
  // kangentic:begin exception-port-reset
  // EXC_MASK_ALL leaves out EXC_MASK_CRASH. Crashpad claims EXC_CRASH and
  // EXC_RESOURCE, so EXC_CRASH has to be named on its own.
  task_set_exception_ports(mach_task_self(), EXC_MASK_ALL | EXC_MASK_CRASH,
                           MACH_PORT_NULL, EXCEPTION_DEFAULT, THREAD_STATE_NONE);
  // kangentic:end

  char *slave_path = ttyname(STDIN_FILENO);
  // open implicit attaches a process to a terminal device if:
  // - process has no controlling terminal yet
  // - O_NOCTTY is not set
  close(open(slave_path, O_RDWR));

  char *cwd = argv[1];
  char *file = argv[2];
  argv = &argv[2];

  if (strlen(cwd) && chdir(cwd) == -1) {
    _exit(1);
  }

  execvp(file, argv);
  return 1;
}
