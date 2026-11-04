import vigil


def test_version_is_set():
    assert vigil.__version__ == "0.1.0"


def test_main_prints_version(capsys):
    vigil.main()
    assert capsys.readouterr().out.strip() == "Vigil 0.1.0"
