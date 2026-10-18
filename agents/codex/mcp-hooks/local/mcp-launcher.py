"""Launch the project selected by the MCP process working directory."""

import os
import sys
from client import project, ssh
from mcp_transport import main

if __name__ == "__main__":
    try:
        selected = project(os.getcwd())
        if selected is None:
            raise ValueError("No project configured for the MCP working directory")
        main(ssh(selected, selected["mcp_command"]))
    except (ValueError, KeyError, OSError) as exc:
        print("Team assets launcher: " + str(exc), file=sys.stderr)
        sys.exit(1)
