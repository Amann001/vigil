from vigil import tracing


def test_tracing_is_off_without_keys(monkeypatch):
    assert tracing.run_config("live-1", "investigation") == {}  # conftest turns tracing off


def test_a_traced_run_is_labelled_with_its_investigation(monkeypatch):
    monkeypatch.setattr(tracing, "enabled", lambda: True)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test")
    monkeypatch.setenv("LANGFUSE_HOST", "https://cloud.langfuse.com")
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)

    config = tracing.run_config("live-1", "review")

    assert len(config["callbacks"]) == 1
    assert config["metadata"]["langfuse_session_id"] == "live-1"
    assert config["metadata"]["langfuse_tags"] == ["vigil", "review"]
    assert tracing.os.environ["LANGFUSE_BASE_URL"] == "https://cloud.langfuse.com"
