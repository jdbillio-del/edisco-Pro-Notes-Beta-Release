import React, { useEffect, useMemo, useState } from "react";

type VaultStatus = { locked: boolean; hasEncryptedDb: boolean; hasPlaintextDb: boolean };

type Props = {
  children: React.ReactNode;
};

const MIN_PASSPHRASE_LEN = 12;

const maskInfo = (text: string) => text;

const VaultGate: React.FC<Props> = ({ children }) => {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    window.edisconotes
      .vaultStatus()
      .then((s) => setStatus(s))
      .catch((e) => {
        console.error("Failed to fetch vault status", e);
        setError("Failed to initialize vault status.");
      });
  }, []);

  const mode = useMemo(() => {
    if (!status) return "loading" as const;
    if (!status.locked) return "unlocked" as const;
    return status.hasEncryptedDb ? ("unlock" as const) : ("create" as const);
  }, [status]);

  const canSubmit = useMemo(() => {
    if (working) return false;
    if (!passphrase || passphrase.length < MIN_PASSPHRASE_LEN) return false;
    if (mode === "create" && passphrase !== confirm) return false;
    return mode === "create" || mode === "unlock";
  }, [working, passphrase, confirm, mode]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setInfo(null);

    if (mode === "create" && passphrase !== confirm) {
      setError("Passphrases do not match.");
      return;
    }

    setWorking(true);
    try {
      const result = await window.edisconotes.vaultUnlock(passphrase);
      const next = await window.edisconotes.vaultStatus();
      setStatus(next);
      setPassphrase("");
      setConfirm("");
      const bits: string[] = [];
      if (result?.migratedDb) bits.push("migrated plaintext database");
      if ((result?.migratedAttachments || 0) > 0) bits.push(`migrated ${result?.migratedAttachments} attachments`);
      if (result?.unlockSource && result.unlockSource !== "current") {
        bits.push(`recovered vault from ${result.unlockSource}`);
      }
      if ((result?.seededLegacyAttachments || 0) > 0) {
        bits.push(`seeded ${result.seededLegacyAttachments} legacy attachments`);
      }
      setInfo(bits.length ? `Completed: ${bits.join(", ")}.` : null);
    } catch (e: any) {
      const message = typeof e?.message === "string" ? e.message : "Unlock failed.";
      setError(maskInfo(message));
    } finally {
      setWorking(false);
    }
  };

  if (mode === "unlocked") {
    return <>{children}</>;
  }

  return (
    <div className="vault-gate">
      <div className="vault-card">
        <div className="vault-header">
          <div className="vault-title">eDisco Pro Notes</div>
          <div className="vault-subtitle">
            {mode === "loading" ? "Loading…" : mode === "create" ? "Set an encryption passphrase" : "Unlock encrypted vault"}
          </div>
        </div>

        {status?.hasPlaintextDb && status?.locked && !status?.hasEncryptedDb ? (
          <div className="vault-banner vault-banner-warn">
            Plaintext data found. After unlocking, it will be migrated to encrypted storage and the plaintext database will be removed.
          </div>
        ) : null}

        {status?.hasPlaintextDb && status?.locked && status?.hasEncryptedDb ? (
          <div className="vault-banner vault-banner-warn">
            Plaintext attachments may exist from an older version. After unlocking, they will be migrated to encrypted storage.
          </div>
        ) : null}

        {error ? <div className="vault-banner vault-banner-error">{error}</div> : null}
        {info ? <div className="vault-banner vault-banner-ok">{info}</div> : null}

        <form onSubmit={onSubmit} className="vault-form">
          <label className="vault-label">
            <div className="vault-label-text">Passphrase</div>
            <input
              className="vault-input"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
              autoComplete="current-password"
              placeholder={`At least ${MIN_PASSPHRASE_LEN} characters`}
            />
          </label>

          {mode === "create" ? (
            <label className="vault-label">
              <div className="vault-label-text">Confirm passphrase</div>
              <input
                className="vault-input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                placeholder="Re-enter passphrase"
              />
            </label>
          ) : null}

          {mode === "create" ? (
            <div className="vault-note">
              If you forget your passphrase, encrypted data cannot be recovered.
            </div>
          ) : null}

          <button className="vault-button" type="submit" disabled={!canSubmit}>
            {working ? "Working…" : mode === "create" ? "Enable Encryption" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default VaultGate;
