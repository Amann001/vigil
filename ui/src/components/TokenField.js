import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { setToken } from "../lib/api";
/** Changing the system needs the API token from .env; it is kept only for this browser tab. */
export function TokenField({ onSaved }) {
    const [value, setValue] = useState("");
    return (_jsxs("form", { className: "token", onSubmit: (e) => {
            e.preventDefault();
            if (!value.trim())
                return;
            setToken(value.trim());
            onSaved();
        }, children: [_jsxs("label", { htmlFor: "token-input", children: [_jsx("strong", { children: "Your API token" }), _jsxs("span", { children: ["Anything that changes the shop needs ", _jsx("code", { children: "VIGIL_API_TOKEN" }), " from your ", _jsx("code", { children: ".env" }), ". It is kept only until you close this tab."] })] }), _jsxs("div", { className: "token-row", children: [_jsx("input", { id: "token-input", type: "password", autoComplete: "off", value: value, onChange: (e) => setValue(e.target.value), placeholder: "Paste the token" }), _jsx("button", { className: "button", type: "submit", disabled: !value.trim(), children: "Use token" })] })] }));
}
