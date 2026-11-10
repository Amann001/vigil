import { useState } from "react";
import { setToken } from "../lib/api";

/** Changing the system needs the API token from .env; it is kept only for this browser tab. */
export function TokenField({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="token"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setToken(value.trim());
        onSaved();
      }}
    >
      <label htmlFor="token-input">
        <strong>Your API token</strong>
        <span>
          Anything that changes the shop needs <code>VIGIL_API_TOKEN</code> from your <code>.env</code>. It is kept
          only until you close this tab.
        </span>
      </label>
      <div className="token-row">
        <input
          id="token-input"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the token"
        />
        <button className="button" type="submit" disabled={!value.trim()}>
          Use token
        </button>
      </div>
    </form>
  );
}
