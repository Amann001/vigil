import pytest

import vigil
from vigil.cli import main


def test_version_is_set():
    assert vigil.__version__ == "0.1.0"


def test_cli_lists_its_commands(capsys):
    with pytest.raises(SystemExit):
        main(["--help"])

    help_text = capsys.readouterr().out
    for command in ("watch", "replay", "list", "show", "review"):
        assert command in help_text
