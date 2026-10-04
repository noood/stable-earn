"use client";

import { useEffect, useRef, useState } from "react";
import { AccountBadge, ActionButton, ModalFrame, SectionIntro } from "@/app/components/ui";
import { useDismissibleDetails } from "@/app/components/use-dismissible-details";
import type { Account } from "@/lib/domain";
import { accounts } from "@/lib/seed-data";
import { apiCheckSuccessFeedbackMs, initialApiCheckUiState, transitionApiCheckUiState } from "@/lib/api-check-ui-state";

type ApiCredentialSource = {
  id: string;
  label: string;
  configured: boolean;
  requiresPassphrase: boolean;
  syncDescription: string;
};
type ManualDataSource = {
  id: string;
  label: string;
  statusLabel?: string;
  syncDescription: string;
};
type ApiConfigResult = { sources: ApiCredentialSource[]; manualSources: ManualDataSource[] };
type ManualRefreshCooldownMinutes = 0 | 30;
type PreferencesResult = { manualRefreshCooldownMinutes: ManualRefreshCooldownMinutes };
type CapabilityReport = { generatedAt: string; dataChangesCommitted: false; includesHoldingAmounts: false; checkedScopeCount: number; checkedItemCount: number; checks: unknown[]; additionalProbes?: unknown[]; [key: string]: unknown };

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

export function ApiSettings({ open, onClose, onCooldownChange, onCredentialsRemoved }: { open: boolean; onClose: () => void; onCooldownChange: () => void; onCredentialsRemoved: () => Promise<void> }) {
  const [status, setStatus] = useState<ApiConfigResult | null>(() => apiConfigSessionCache);
  const [cooldownMinutes, setCooldownMinutes] = useState<ManualRefreshCooldownMinutes | null>(() => cooldownSessionCache);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ApiCredentialSource | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingCooldown, setSavingCooldown] = useState(false);
  const [apiCheckState, setApiCheckState] = useState(initialApiCheckUiState);
  const [capabilityReport, setCapabilityReport] = useState<CapabilityReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);
  const capabilityCompletionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function loadStatus() {
    return fetch("/private/api/credentials", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("status unavailable");
        return response.json() as Promise<ApiConfigResult>;
      })
      .then((result) => {
        setStatusError(false);
        setStatus(rememberApiConfig(result));
      })
      .catch(() => {
        setStatusError(true);
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

  useEffect(() => () => {
    if (capabilityCompletionTimer.current) clearTimeout(capabilityCompletionTimer.current);
  }, []);

  useEffect(() => {
    if (open) return;
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
    setSelectedId(null);
  }, [open]);

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
      await onCredentialsRemoved();
      await loadStatus();
      setPendingRemoval(null);
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

  async function probeCapabilities() {
    if (capabilityCompletionTimer.current) clearTimeout(capabilityCompletionTimer.current);
    capabilityCompletionTimer.current = null;
    setApiCheckState((current) => transitionApiCheckUiState(current, { type: "start" }));
    setCapabilityReport(null);
    try {
      const response = await fetch("/private/api/diagnostics/platform-capabilities", {
        method: "POST",
        cache: "no-store",
      });
      const result = await response.json() as CapabilityReport & { error?: string };
      if (!response.ok) throw new Error(result.error || "检查失败，请稍后重试。");
      setCapabilityReport(result);
      setApiCheckState((current) => transitionApiCheckUiState(current, { type: "report_generated" }));
      capabilityCompletionTimer.current = setTimeout(() => {
        setApiCheckState((current) => transitionApiCheckUiState(current, { type: "feedback_elapsed" }));
        capabilityCompletionTimer.current = null;
      }, apiCheckSuccessFeedbackMs);
    } catch (error) {
      setCapabilityReport(null);
      setApiCheckState((current) => transitionApiCheckUiState(current, {
        type: "failed",
        error: error instanceof Error ? error.message : "检查失败，请稍后重试。",
      }));
    } finally {
      setApiCheckState((current) => current.phase === "checking"
        ? transitionApiCheckUiState(current, { type: "failed", error: "检查流程未能生成报告。" })
        : current);
    }
  }

  function downloadCapabilityReport() {
    if (!capabilityReport) return;
    const blob = new Blob([`${JSON.stringify(capabilityReport, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `platform-api-check-${new Date(capabilityReport.generatedAt).toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const probingCapabilities = apiCheckState.phase === "checking";
  const modalBusy = busy || savingCooldown || probingCapabilities;

  if (!open) return null;

  if (pendingRemoval) return (
    <ModalFrame ariaLabel="移除 API 配置及产品" title="移除 API 配置及产品" onClose={() => setPendingRemoval(null)} busy={busy}>
      <p className="text-secondary type-body">移除后，该账户关联的所有 API 产品都会从列表中移除。已保存的持仓、产品资料和变更记录会保留；同步缓存会清除，之后重新配置并成功同步即可恢复产品。</p>
      {message && <div className="error-panel type-caption mt-4 px-3 py-2.5" role="alert">{message}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <ActionButton variant="secondary" disabled={busy} onClick={() => setPendingRemoval(null)}>取消</ActionButton>
        <ActionButton variant="danger" disabled={busy} onClick={() => void remove(pendingRemoval.id, pendingRemoval.label)}>{busy ? "正在移除…" : "移除配置及产品"}</ActionButton>
      </div>
    </ModalFrame>
  );

  return (
    <ModalFrame ariaLabel="API 设置" title="API 设置" onClose={onClose} busy={modalBusy} bodyClassName="api-settings-body space-y-6">
      <section>
        <div className="api-settings-split-row">
          <SectionIntro title="手动刷新频率" description="仅限制手动刷新；不影响每日 07:00 更新和当天首次打开时的刷新。设置同步至此邮箱所有设备。" />
          <div className="cooldown-options" role="radiogroup" aria-label="手动刷新冷却时间" aria-busy={cooldownMinutes === null || savingCooldown}>
            {([{ value: 0, label: "无" }, { value: 30, label: "30 分钟" }] as const).map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={cooldownMinutes === option.value} className="cooldown-option" disabled={cooldownMinutes === null || savingCooldown} onClick={() => void updateCooldown(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>
      {message && <div className="muted-panel type-caption px-3 py-2.5 font-normal">{message}</div>}
      <section>
        <SectionIntro title="配置 API" description="Key 和 Secret 由服务器加密保存；完整密钥不会返回浏览器。" />
        {statusError && <div className="error-panel type-caption mb-3 px-3 py-2.5" role="alert">配置状态读取失败，请重试。<ActionButton variant="text" size="small" onClick={() => { setStatusError(false); void loadStatus(); }}>重试</ActionButton></div>}
        <div className="api-connection-list">
          {status?.sources.map((source, index) => {
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
              <div key={source.id} className={`api-connection-row ${index ? "api-connection-row-divided" : ""}`}>
                <div className="flex items-center justify-between gap-3">
                  <SourceSummary account={account} label={source.label} statusLabel={statusLabel} statusClass={statusClass} description={source.syncDescription} />
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!source.configured && <ActionButton variant="secondary" disabled={modalBusy} onClick={openEditor}>添加</ActionButton>}
                    {source.configured && <ApiRowMenu label={source.label} disabled={modalBusy || isSelected} onUpdate={openEditor} onRemove={() => { setMessage(null); setPendingRemoval(source); }} />}
                  </div>
                </div>
                {isSelected && <form className="api-credential-form mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }} autoComplete="off"><div><h4 className="type-body font-semibold">配置 {source.label}</h4><p className="text-muted type-caption mt-1">只填写只读密钥；交易、转账、申购、赎回和提现权限必须关闭。</p></div><SecretField label="API Key" value={apiKey} onChange={setApiKey} /><SecretField label="API Secret" value={apiSecret} onChange={setApiSecret} />{source.requiresPassphrase && <SecretField label="Passphrase" value={passphrase} onChange={setPassphrase} />}<div className="flex justify-end gap-2"><ActionButton type="button" variant="secondary" disabled={modalBusy} onClick={() => { setSelectedId(null); clearForm(); }}>取消</ActionButton><ActionButton type="submit" disabled={modalBusy || !apiKey.trim() || !apiSecret.trim() || (source.requiresPassphrase && !passphrase.trim())}>{busy ? "加密保存中…" : "加密保存"}</ActionButton></div></form>}
              </div>
            );
          }) ?? (statusError ? null : <ApiSettingsSkeleton />)}
          {(status?.manualSources ?? []).map((source, index) => {
            const account = accounts.find((item) => item.id === source.id);
            const divided = (status?.sources.length ?? 0) > 0 || index > 0;
            return <div key={source.id} className={`api-connection-row ${divided ? "api-connection-row-divided" : ""}`}><SourceSummary account={account} label={source.label} statusLabel={source.statusLabel ?? "手动维护"} statusClass="status-chip-muted" description={source.syncDescription} /></div>;
          })}
        </div>
      </section>
      <section>
        <div className="api-settings-split-row">
          <SectionIntro title="API 检测" description="只读检查已知接口，不写入产品、持仓或历史；报告不含持仓金额或密钥。OKX On-chain Earn 单独检查。" />
          <div className="api-check-actions">
            <ActionButton
              variant="secondary"
              className="api-check-button"
              aria-label={probingCapabilities ? "正在检测 API" : apiCheckState.phase === "complete" ? "检测完成" : "检测 API"}
              disabled={modalBusy}
              onClick={() => void probeCapabilities()}
            >
              {probingCapabilities
                ? <span className="api-check-spinner" aria-hidden="true" />
                : apiCheckState.phase === "complete"
                  ? <svg className="api-check-success-icon" viewBox="0 0 14 14" aria-hidden="true"><path d="m2.5 7.25 2.8 2.8 6.2-6.1" /></svg>
                  : "检测 API"}
            </ActionButton>
            {capabilityReport && apiCheckState.downloadable && <>
              <ActionButton variant="text" size="small" onClick={downloadCapabilityReport}>下载 JSON（{new Date(capabilityReport.generatedAt).toLocaleDateString("zh-CN")}）</ActionButton>
            </>}
          </div>
        </div>
        {apiCheckState.error && <p className="error-panel type-caption mt-3 px-3 py-2" role="alert">{apiCheckState.error}</p>}
      </section>
    </ModalFrame>
  );
}

function SourceSummary({ account, label, statusLabel, statusClass, description }: { account?: Account; label: string; statusLabel: string; statusClass: string; description: string }) {
  return <div className="flex min-w-0 items-center gap-3">{account && <AccountBadge account={account} />}<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="type-label font-semibold">{label}</span><span className={`status-chip status-chip-compact ${statusClass}`}>{statusLabel}</span></div><p className="text-secondary type-caption mt-2">{description}</p></div></div>;
}

function ApiSettingsSkeleton() {
  return <div className="api-settings-skeleton" aria-label="正在读取配置状态" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div key={index} className="api-settings-skeleton-row"><span className="api-settings-skeleton-badge" /><span className="api-settings-skeleton-copy"><span /><span /></span></div>)}</div>;
}

function ApiRowMenu({ label, disabled, onUpdate, onRemove }: { label: string; disabled: boolean; onUpdate: () => void; onRemove: () => void }) {
  const menuRef = useDismissibleDetails();

  return <details ref={menuRef} className="api-row-menu relative"><summary className="icon-button api-row-menu-trigger list-none" aria-label={`${label} 更多操作`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={(event) => { if (disabled) event.preventDefault(); }}><span aria-hidden="true">⋯</span></summary><div className="surface-popover api-row-menu-popover"><button type="button" onClick={() => { menuRef.current?.removeAttribute("open"); onUpdate(); }} className="menu-item menu-item-compact">更新 API 配置</button><button type="button" onClick={() => { menuRef.current?.removeAttribute("open"); onRemove(); }} className="menu-item menu-item-compact menu-item-danger">移除 API 配置</button></div></details>;
}

function SecretField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="text-secondary type-caption mb-1.5 block font-normal">{label}</span><input type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} className="secret-input type-body" /></label>;
}
