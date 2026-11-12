// Add-account (pool OAuth) flow: the begin/complete/cancel handlers, the local
// form state, and the watcher that closes the form and toasts when the backend
// reports the polled auth flow as done/failed.

import { en, type AgyLocaleKey } from '../locales.ts';
import { postPool } from '../api.ts';
import { useEffect, useRef, useState } from '../react.ts';
import type { StatusPayload } from '../status.ts';
import type { ShowToast } from '../ui/Toast.ts';
import type { Translator } from './useTranslation.ts';

export interface AuthFlowDeps {
	status: StatusPayload | null;
	refresh: () => Promise<void>;
	showToast: ShowToast;
	setLoadingAction: (value: string | null) => void;
	t: Translator;
}

export interface AuthFlow {
	addingAccount: boolean;
	setAddingAccount: (value: boolean) => void;
	importMode: boolean;
	setImportMode: (value: boolean) => void;
	aliasInput: string;
	setAliasInput: (value: string) => void;
	addProxyInput: string;
	setAddProxyInput: (value: string) => void;
	authCodeInput: string;
	setAuthCodeInput: (value: string) => void;
	tokenInput: string;
	setTokenInput: (value: string) => void;
	safeMessage: (code?: string) => string;
	handleBeginAddAccount: () => Promise<void>;
	handleCompleteAddAccount: () => Promise<void>;
	handleCancelAddAccount: () => Promise<void>;
	handleImportToken: () => Promise<void>;
	poolAuth: StatusPayload['poolAuth'] | undefined;
	flowPhase: 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed';
	flowActive: boolean;
}

function toSafeMessage(t: Translator, code?: string): string {
	const key = `auth.code.${code ?? ''}` as AgyLocaleKey;
	return code && key in en ? t(key) : t('api.genericError');
}

export function useAuthFlow({ status, refresh, showToast, setLoadingAction, t }: AuthFlowDeps): AuthFlow {
	const [aliasInput, setAliasInput] = useState('');
	const [addingAccount, setAddingAccount] = useState(false);
	const [importMode, setImportMode] = useState(false);
	const [authCodeInput, setAuthCodeInput] = useState('');
	const [addProxyInput, setAddProxyInput] = useState('');
	const [tokenInput, setTokenInput] = useState('');
	const flowStartedRef = useRef(false);

	const safeMessage = (code?: string): string => toSafeMessage(t, code);

	const resetForm = () => {
		setAuthCodeInput('');
		setAliasInput('');
		setAddProxyInput('');
		setTokenInput('');
		setImportMode(false);
	};

	useEffect(() => {
		if (!addingAccount || !flowStartedRef.current) return;
		const pa = status?.poolAuth;
		if (!pa) return;
		if (pa.phase === 'done') {
			flowStartedRef.current = false;
			setAddingAccount(false);
			resetForm();
			showToast(safeMessage(pa.code), 'success');
		} else if (pa.phase === 'failed') {
			flowStartedRef.current = false;
			showToast(safeMessage(pa.code), 'error');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [addingAccount, status?.poolAuth?.phase, status?.poolAuth?.code]);

	const handleBeginAddAccount = async (): Promise<void> => {
		setLoadingAction('pool:beginAdd');
		const alias = aliasInput.trim();
		const proxyUrl = addProxyInput.trim();
		const res = await postPool('begin-add', {
			...(alias ? { alias } : {}),
			...(proxyUrl ? { proxyUrl } : {}),
		});
		setLoadingAction(null);
		if (res && res.ok) {
			flowStartedRef.current = true;
			await refresh();
			showToast(res.browserOpened ? t('auth.browserOpened') : t('auth.browserManual'), res.browserOpened ? 'info' : 'warn');
		} else {
			showToast(res?.code ? safeMessage(res.code) : t('auth.startFailed'), 'error');
		}
	};

	const handleCompleteAddAccount = async (): Promise<void> => {
		if (!authCodeInput.trim()) return;
		setLoadingAction('pool:completeAdd');
		const res = await postPool('complete-add', { code: authCodeInput.trim() });
		setLoadingAction(null);
		if (res && res.ok) {
			flowStartedRef.current = false;
			resetForm();
			setAddingAccount(false);
			await refresh();
			showToast(safeMessage(res.code), 'success');
		} else {
			showToast(safeMessage(res?.code), 'error');
		}
	};

	const handleCancelAddAccount = async (): Promise<void> => {
		flowStartedRef.current = false;
		await postPool('cancel-add', {});
		resetForm();
		setAddingAccount(false);
		await refresh();
	};

	const handleImportToken = async (): Promise<void> => {
		if (!tokenInput.trim()) return;
		setLoadingAction('pool:importToken');
		const res = await postPool('import', {
			token: tokenInput.trim(),
			...(aliasInput.trim() ? { alias: aliasInput.trim() } : {}),
			...(addProxyInput.trim() ? { proxyUrl: addProxyInput.trim() } : {}),
		});
		setLoadingAction(null);
		if (res && res.ok) {
			resetForm();
			setAddingAccount(false);
			await refresh();
			showToast(`${t('auth.importSuccess')}${res.email ? ` (${res.email})` : ''}`, 'success');
		} else {
			showToast(res?.error ? `${t('auth.importFailed')}: ${res.error}` : t('auth.importFailed'), 'error');
		}
	};

	const poolAuth = status?.poolAuth;
	const flowPhase = poolAuth?.phase ?? 'idle';

	return {
		addingAccount, setAddingAccount, importMode, setImportMode,
		aliasInput, setAliasInput, addProxyInput, setAddProxyInput,
		authCodeInput, setAuthCodeInput, tokenInput, setTokenInput,
		safeMessage, handleBeginAddAccount, handleCompleteAddAccount,
		handleCancelAddAccount, handleImportToken,
		poolAuth, flowPhase, flowActive: flowPhase === 'waiting' || flowPhase === 'exchanging',
	};
}
