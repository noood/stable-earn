"use client";

import { useEffect, useState } from "react";
import { AccountBadge, ActionButton, ModalFrame, SectionIntro } from "@/app/components/ui";
import { useDismissibleDetails } from "@/app/components/use-dismissible-details";
import { accounts } from "@/lib/seed-data";

type ApiCredentialSource = {
  id: string;
  label: string;
  mode: "api";
  configured: boolean;
  requiresPassphrase: boolean;
  syncDescription: string;
};
type ManualDataSource = {
  id: string;
  label: string;
  mode: "manual";
  syncDescription: string;
};
type ApiConfigResult = { sources: ApiCredentialSource[]; manualSources: ManualDataSource[] };
type ManualRefreshCooldownMinutes = 0 | 30;
type PreferencesResult = { manualRefreshCooldownMinutes: ManualRefreshCooldownMinutes };

let apiConfigSessionCache: ApiConfigResult | null = null;
let cooldownSessionCache: ManualRefreshCooldownMinutes | null = null;

function rememberApiConfig(result: ApiConfigResult) {
  apiConfigSessionCache = result;
  return result;
}

function rememberCooldown(minutes: ManualRefreshCooldownMinutes) {
  cooldownSessionCache = minutes;
  return minutes;
}

export function ApiSettings({ onClose, onCooldownChange }: { onClose: () => void; onCooldownChange: () => void }) {
  const [status, setStatus] = useState<ApiConfigResult | null>(() => apiConfigSessionCache);
  const [cooldownMinutes, setCooldownMinutes] = useState<ManualRefreshCooldownMinutes | null>(() => cooldownSessionCache);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingCooldown, setSavingCooldown] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function loadStatus() {
    return fetch("/private/api/credentials", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("status unavailable");
        return response.json() as Promise<ApiConfigResult>;
      })
      .then((result) => {
        setStatus(rememberApiConfig(result));
      })
      .catch(() => {
        if (!apiConfigSessionCache) setStatus(null);
      });
  }

  useEffect(() => {
    void loadStatus();
    void fetch("/private/api/preferences", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("preferences unavailable");
        return response.json() as Promise<PreferencesResult>;
      })
      .then((result) => {
        setCooldownMinutes(rememberCooldown(result.manualRefreshCooldownMinutes));
      })
      .catch(() => setCooldownMinutes(cooldownSessionCache ?? 30));
  }, []);

  const selected = status?.sources.find((source) => source.id === selectedId) ?? null;

  function clearForm() {
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/private/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selected.id, apiKey, apiSecret, passphrase }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "保存失败");
      clearForm();
      setSelectedId(null);
      setMessage(`${selected.label} 已加密保存到当前邮箱。`);
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function remove(accountId: string, label: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/private/api/credentials?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("移除失败");
      clearForm();
      setSelectedId(null);
      setMessage(`${label} 的 API 配置已移除。`);
      await loadStatus();
    } catch {
      setMessage("移除失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function updateCooldown(minutes: ManualRefreshCooldownMinutes) {
    if (savingCooldown || cooldownMinutes === minutes) return;
    setSavingCooldown(true);
    setMessage(null);
    try {
      const response = await fetch("/private/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualRefreshCooldownMinutes: minutes }),
      });
      const result = await response.json() as PreferencesResult & { error?: string };
      if (!response.ok) throw new Error(result.error || "保存失败");
      setCooldownMinutes(rememberCooldown(result.manualRefreshCooldownMinutes));
      onCooldownChange();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设置保存失败，请稍后重试。");
    } finally {
      setSavingCooldown(false);
    }
  }

  const modalBusy = busy || savingCooldown;

  return (
    <ModalFrame ariaLabel="API 设置" title="API 设置" onClose={onClose} busy={modalBusy} bodyClassName="api-settings-body space-y-5">
      <div className="highlight-panel type-caption px-4 py-3 text-secondary">浏览器不会保存输入内容。服务器使用 AES-GCM 加密，并将密文绑定到当前邮箱与平台账号；完整 Key 和 Secret 不会从服务器返回。关闭弹窗或保存后，输入内容会从页面状态清除。</div>
      <section>
        <SectionIntro title="手动刷新" description="只限制你主动请求交易所的频率；每天 08:00、20:00 的计划更新不受影响。设置会同步到当前邮箱的所有设备。" />
        <div className="cooldown-options" role="radiogroup" aria-label="手动刷新冷却时间" aria-busy={cooldownMinutes === null || savingCooldown}>
          {([{ value: 0, label: "无" }, { value: 30, label: "30 分钟" }] as const).map((option) => (
            <button key={option.value} type="button" role="radio" aria-checked={cooldownMinutes === option.value} className="cooldown-option" disabled={cooldownMinutes === null || savingCooldown} onClick={() => void updateCooldown(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      </section>
      {message && <div className="muted-panel type-caption px-3 py-2.5 font-medium">{message}</div>}
      <section>
        <SectionIntro title="平台连接" />
        <div className="space-y-2">
          {status?.sources.map((source) => {
            const account = accounts.find((item) => item.id === source.id);
            const isSelected = selected?.id === source.id;
            const statusLabel = source.configured ? "已配置" : "未配置";
            const statusClass = source.configured ? "status-chip-highlight" : "status-chip-muted";
            const openEditor = () => {
              setSelectedId(source.id);
              clearForm();
              setMessage(null);
            };

            return (
              <div key={source.id} className="card px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {account && <AccountBadge account={account} />}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="type-label font-semibold">{source.label}</span>
                        <span className={`status-chip status-chip-compact ${statusClass}`}>{statusLabel}</span>
                      </div>
                      <p className="text-secondary type-caption mt-2">配置后{source.syncDescription}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!source.configured && <ActionButton variant="secondary" disabled={modalBusy} onClick={openEditor}>添加</ActionButton>}
                    {source.configured && <ApiRowMenu label={source.label} disabled={modalBusy || isSelected} onUpdate={openEditor} onRemove={() => void remove(source.id, source.label)} />}
                  </div>
                </div>
                {isSelected && <form className="api-credential-form mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }} autoComplete="off"><div><h4 className="type-body font-semibold">配置 {source.label}</h4><p className="text-muted type-caption mt-1">只填写只读密钥；交易、转账和提现权限必须关闭。</p></div><SecretField label="API Key" value={apiKey} onChange={setApiKey} /><SecretField label="API Secret" value={apiSecret} onChange={setApiSecret} />{source.requiresPassphrase && <SecretField label="Passphrase" value={passphrase} onChange={setPassphrase} />}<div className="flex justify-end gap-2"><ActionButton type="button" variant="secondary" disabled={modalBusy} onClick={() => { setSelectedId(null); clearForm(); }}>取消</ActionButton><ActionButton type="submit" disabled={modalBusy || !apiKey.trim() || !apiSecret.trim() || (source.requiresPassphrase && !passphrase.trim())}>{busy ? "加密保存中…" : "加密保存"}</ActionButton></div></form>}
              </div>
            );
          }) ?? <ApiSettingsSkeleton />}
          {(status?.manualSources ?? []).map((source) => {
            const account = accounts.find((item) => item.id === source.id);
            return <div key={source.id} className="card px-4 py-3"><div className="flex items-center gap-3">{account && <AccountBadge account={account} />}<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="type-label font-semibold">{source.label}</span><span className="status-chip status-chip-compact status-chip-muted">手动维护</span></div><p className="text-secondary type-caption mt-2">{source.syncDescription}</p></div></div></div>;
          })}
        </div>
      </section>
    </ModalFrame>
  );
}

function ApiSettingsSkeleton() {
  return <div className="api-settings-skeleton" aria-label="正在读取配置状态" aria-busy="true">{Array.from({ length: 5 }, (_, index) => <div key={index} className="api-settings-skeleton-row"><span className="api-settings-skeleton-badge" /><span className="api-settings-skeleton-copy"><span /><span /></span></div>)}</div>;
}

function ApiRowMenu({ label, disabled, onUpdate, onRemove }: { label: string; disabled: boolean; onUpdate: () => void; onRemove: () => void }) {
  const menuRef = useDismissibleDetails();

  return <details ref={menuRef} className="api-row-menu relative"><summary className="icon-button api-row-menu-trigger list-none" aria-label={`${label} 更多操作`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={(event) => { if (disabled) event.preventDefault(); }}><span aria-hidden="true">⋯</span></summary><div className="surface-popover api-row-menu-popover"><button type="button" onClick={() => { menuRef.current?.removeAttribute("open"); onUpdate(); }} className="menu-item menu-item-compact">更新 API 配置</button><button type="button" onClick={() => { menuRef.current?.removeAttribute("open"); onRemove(); }} className="menu-item menu-item-compact menu-item-danger">移除 API 配置</button></div></details>;
}

function SecretField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="text-secondary type-caption mb-1.5 block font-medium">{label}</span><input type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} className="secret-input type-body" /></label>;
}
