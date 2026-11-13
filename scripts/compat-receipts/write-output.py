"""Write the two receipt artifacts through an inherited, verified directory capability."""
import json
import os
import stat
import sys

FD = 3
FILES = ("summary.json", "receipt.md")
PAYLOAD_BYTES = 4 * 1024 * 1024


def check_directory():
    info = os.fstat(FD)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("output")
    for name in FILES:
        try:
            os.stat(name, dir_fd=FD, follow_symlinks=False)
        except FileNotFoundError:
            continue
        raise ValueError("output")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("check", "write"):
        raise ValueError("output")
    check_directory()
    if sys.argv[1] == "check":
        return
    payload = sys.stdin.buffer.read(PAYLOAD_BYTES + 1)
    if len(payload) > PAYLOAD_BYTES:
        raise ValueError("output")
    values = json.loads(payload.decode("utf-8"))
    if not isinstance(values, list) or len(values) != len(FILES) or not all(isinstance(value, str) for value in values):
        raise ValueError("output")
    encoded = [value.encode("utf-8") for value in values]
    # Acquire both exclusive leaves before publishing any content. On a collision,
    # an empty newly created leaf is retained rather than unlinking a replaced name.
    descriptors = []
    try:
        for name in FILES:
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=FD)
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise ValueError("output")
        for descriptor, data in zip(descriptors, encoded):
            remaining = memoryview(data)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise ValueError("output")
                remaining = remaining[written:]
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print receipt contents, paths, environment values or filesystem errors.
        print("output", file=sys.stderr)
        sys.exit(2)
