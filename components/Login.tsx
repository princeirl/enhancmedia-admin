"use client";

import { useState } from "react";
import { api } from "@/lib/api";

/** Sign-in: email, then the 6-digit code sent to it. */
export function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === "email") {
        await api.requestCode(email);
        setStep("code");
      } else {
        await api.verifyCode(code);
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-8 shadow-xl">
        <p className="text-sm font-semibold tracking-[0.3em]">ENHANC MEDIA</p>
        <h1 className="mt-6 text-xl font-semibold">Sign in to the admin</h1>
        {step === "email" ? (
          <>
            <p className="mt-2 text-sm text-muted">We will email you a sign-in code.</p>
            <label htmlFor="email" className="label mt-6">Email address</label>
            <input id="email" type="email" autoComplete="email" required autoFocus className="input mt-1.5" value={email} onChange={(e) => setEmail(e.target.value)} />
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              If <strong className="text-ink">{email}</strong> may sign in, a 6-digit code is on its way. It expires in 10 minutes.
            </p>
            <label htmlFor="code" className="label mt-6">Code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              className="input mt-1.5 font-mono text-lg tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </>
        )}
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy} className="btn-primary mt-6 w-full py-2.5">
          {busy ? "Please wait…" : step === "email" ? "Send code" : "Sign in"}
        </button>
        {step === "code" && (
          <button type="button" className="mt-3 w-full text-center text-sm text-muted hover:text-ink" onClick={() => { setStep("email"); setCode(""); setError(null); }}>
            Use a different email or send a new code
          </button>
        )}
      </form>
    </div>
  );
}
