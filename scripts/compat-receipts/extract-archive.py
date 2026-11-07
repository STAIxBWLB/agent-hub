"""Bounded extraction of an already verified archive into an owned empty prefix."""
import os
import gzip
import tempfile
from pathlib import Path, PurePosixPath
import sys
import tarfile


def extract(archive, destination, entry_limit, byte_limit):
    destination = Path(destination)
    if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("integrity")
    # Bound raw decompression too: tarfile parses PAX/long-name headers internally.
    # A malicious extension header must not allocate beyond the expanded budget.
    with tempfile.TemporaryFile(dir=Path(archive).parent) as unpacked:
        with gzip.open(archive, "rb") as compressed:
            raw_limit = byte_limit + entry_limit * 1024 + 10240
            raw_count = 0
            while True:
                chunk = compressed.read(min(65536, raw_limit - raw_count + 1))
                if not chunk:
                    break
                raw_count += len(chunk)
                if raw_count > raw_limit:
                    raise ValueError("integrity")
                unpacked.write(chunk)
        unpacked.seek(0)
        with tarfile.open(fileobj=unpacked, mode="r:") as source:
            members = []
            names = set()
            expanded = 0
            # Validate every header before writing anything. Iteration avoids getmembers' unbounded list.
            for member in source:
                raw = member.name
                name = PurePosixPath(raw)
                if "\\" in raw or name.is_absolute() or ".." in name.parts or not name.parts:
                    raise ValueError("integrity")
                if not (member.isfile() or member.isdir()) or member.issym() or member.islnk():
                    raise ValueError("integrity")
                normalized = str(name)
                if normalized in names:
                    raise ValueError("integrity")
                names.add(normalized)
                expanded += member.size
                members.append((member, name))
                if len(members) > entry_limit or expanded > byte_limit or member.size < 0:
                    raise ValueError("integrity")
            for member, name in members:
                target = destination.joinpath(*name.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.extractfile(member) as payload:
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if member.mode & 0o111 else 0o600)
                    with os.fdopen(descriptor, "wb") as output:
                        remaining = member.size
                        while remaining:
                            chunk = payload.read(min(remaining, 65536))
                            if not chunk:
                                raise ValueError("integrity")
                            output.write(chunk)
                            remaining -= len(chunk)


if __name__ == "__main__":
    try:
        extract(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    except Exception:
        # Never include archive-controlled names or filesystem details in diagnostics.
        print("integrity", file=sys.stderr)
        sys.exit(2)
