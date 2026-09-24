// Build-time probe for Kangentic's spawn-helper (build/spawn-helper/spawn-helper.c).
// Never shipped. build/install-spawn-helper.js compiles it into a temp directory
// and runs `harness <helper>` against the helper it is about to ship.
//
//   check              Exit 10 if this task has any task-level exception port,
//                      0 if it has none.
//   harness <helper>   Give this task an EXC_CRASH port, then:
//                      1. Control: spawn itself in `check` mode and require 10.
//                         That proves a child inherits the port here, so the
//                         gate cannot pass just because nothing was inherited.
//                      2. Spawn <helper> "" <self> check, the argv layout
//                         node-pty uses, and require 0: the helper cleared the
//                         port before it exec'd the target.
//   with-port <program> [args...]
//                      Give this task the same EXC_CRASH port, spawn <program>
//                      as a child, and exit with its exit code. The probe stays
//                      alive holding the port's receive right the whole time,
//                      so the child inherits a live port, the way every child
//                      of Kangentic inherits Crashpad's. The self-test runs
//                      Node under it to prove a child_process launch through
//                      the helper (src/main/pty/spawn/shell-launch.ts).

#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;

enum {
  EXIT_NO_PORT = 0,
  EXIT_USAGE = 2,
  EXIT_SETUP_FAILED = 3,
  EXIT_CONTROL_FAILED = 4,
  EXIT_HELPER_FAILED = 5,
  EXIT_PORT_PRESENT = 10,
};

static int check_mode(void) {
  exception_mask_t masks[EXC_TYPES_COUNT];
  mach_msg_type_number_t count = EXC_TYPES_COUNT;
  exception_handler_t handlers[EXC_TYPES_COUNT];
  exception_behavior_t behaviors[EXC_TYPES_COUNT];
  thread_state_flavor_t flavors[EXC_TYPES_COUNT];
  // EXC_MASK_ALL leaves out EXC_MASK_CRASH, the port harness_mode installs and
  // Crashpad claims, so without it this check could never see either one.
  kern_return_t result = task_get_exception_ports(
      mach_task_self(), EXC_MASK_ALL | EXC_MASK_CRASH, masks, &count, handlers,
      behaviors, flavors);
  if (result != KERN_SUCCESS) {
    fprintf(stderr, "check: task_get_exception_ports failed (%d)\n", result);
    return EXIT_SETUP_FAILED;
  }
  for (mach_msg_type_number_t index = 0; index < count; index++) {
    if (MACH_PORT_VALID(handlers[index])) {
      return EXIT_PORT_PRESENT;
    }
  }
  return EXIT_NO_PORT;
}

// Spawns path with argv, waits for it, and stores its exit code. Returns 0 on a
// normal exit and -1 (after printing why, prefixed with mode) on anything else.
static int spawn_and_wait(const char *mode, const char *path, char *const argv[], int *exit_code) {
  pid_t child_pid;
  int spawn_result = posix_spawn(&child_pid, path, NULL, NULL, argv, environ);
  if (spawn_result != 0) {
    fprintf(stderr, "%s: posix_spawn %s failed: %s\n", mode, path, strerror(spawn_result));
    return -1;
  }
  int status;
  while (waitpid(child_pid, &status, 0) == -1) {
    if (errno != EINTR) {
      fprintf(stderr, "%s: waitpid for %s failed: %s\n", mode, path, strerror(errno));
      return -1;
    }
  }
  if (!WIFEXITED(status)) {
    fprintf(stderr, "%s: %s did not exit normally (wait status %d)\n", mode, path, status);
    return -1;
  }
  *exit_code = WEXITSTATUS(status);
  return 0;
}

// Gives this task an EXC_CRASH port whose receive right it keeps, so every
// child spawned afterwards inherits a live port. Returns 0, or -1 after
// printing why.
static int install_exception_port(const char *mode) {
  mach_port_t exception_port = MACH_PORT_NULL;
  kern_return_t result = mach_port_allocate(
      mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &exception_port);
  if (result == KERN_SUCCESS) {
    result = mach_port_insert_right(
        mach_task_self(), exception_port, exception_port, MACH_MSG_TYPE_MAKE_SEND);
  }
  if (result == KERN_SUCCESS) {
    // EXCEPTION_STATE hands the handler no task or thread port, so no
    // exception-port hardening policy has a reason to refuse it.
    result = task_set_exception_ports(
        mach_task_self(), EXC_MASK_CRASH, exception_port,
        EXCEPTION_STATE | MACH_EXCEPTION_CODES, MACHINE_THREAD_STATE);
  }
  if (result != KERN_SUCCESS) {
    fprintf(stderr, "%s: could not install a task exception port (%d)\n", mode, result);
    return -1;
  }
  return 0;
}

static int harness_mode(char *helper_path) {
  char self_path[PATH_MAX];
  uint32_t self_path_size = sizeof(self_path);
  if (_NSGetExecutablePath(self_path, &self_path_size) != 0) {
    fprintf(stderr, "harness: could not resolve the probe's own path\n");
    return EXIT_SETUP_FAILED;
  }

  if (install_exception_port("harness") != 0) {
    return EXIT_SETUP_FAILED;
  }

  int exit_code = -1;
  char check_argument[] = "check";
  char *control_argv[] = {self_path, check_argument, NULL};
  if (spawn_and_wait("harness", self_path, control_argv, &exit_code) != 0) {
    return EXIT_CONTROL_FAILED;
  }
  if (exit_code != EXIT_PORT_PRESENT) {
    fprintf(stderr,
            "harness: control child did not see the inherited exception port (exit %d), "
            "so this gate cannot observe inheritance\n",
            exit_code);
    return EXIT_CONTROL_FAILED;
  }

  char empty_cwd[] = "";
  char *helper_argv[] = {helper_path, empty_cwd, self_path, check_argument, NULL};
  if (spawn_and_wait("harness", helper_path, helper_argv, &exit_code) != 0) {
    return EXIT_HELPER_FAILED;
  }
  if (exit_code == EXIT_PORT_PRESENT) {
    fprintf(stderr, "harness: a child exec'd through the helper still had an exception port\n");
    return EXIT_HELPER_FAILED;
  }
  if (exit_code != EXIT_NO_PORT) {
    fprintf(stderr, "harness: the child exec'd through the helper exited %d\n", exit_code);
    return EXIT_HELPER_FAILED;
  }

  printf("control saw the inherited port, the helper's child saw none\n");
  return EXIT_NO_PORT;
}

// The child's own exit code comes back unchanged, so the caller must read the
// child's output for the verdict. A failure here before the child ran is
// EXIT_SETUP_FAILED, with the reason on stderr.
static int with_port_mode(char **program_argv) {
  if (install_exception_port("with-port") != 0) {
    return EXIT_SETUP_FAILED;
  }
  // Flush before the child writes to the same stdout, so no output interleaves.
  fflush(stdout);
  int exit_code = -1;
  if (spawn_and_wait("with-port", program_argv[0], program_argv, &exit_code) != 0) {
    return EXIT_SETUP_FAILED;
  }
  return exit_code;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "check") == 0) {
    return check_mode();
  }
  if (argc == 3 && strcmp(argv[1], "harness") == 0) {
    return harness_mode(argv[2]);
  }
  if (argc >= 3 && strcmp(argv[1], "with-port") == 0) {
    return with_port_mode(&argv[2]);
  }
  fprintf(stderr,
          "usage: exception-port-probe check | harness <spawn-helper path> | "
          "with-port <program> [args...]\n");
  return EXIT_USAGE;
}
