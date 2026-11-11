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
	aliasInput: string;
	setAliasInput: (value: string) => void;
	addProxyInput: string;
	setAddProxyInput: (value: string) => void;
	authCodeInput: string;
	setAuthCodeInput: (value: string) => void;
	safeMessage: (code?: string) => string;
	handleBeginAddAccount: () => Promise<void>;
	handleCompleteAddAccount: () => Promise<void>;
	handleCancelAddAccount: () => Promise<void>;
	poolAuth: StatusPayload['poolAuth'] | undefined;
	flowPhase: 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed';
	flowActive: boolean;
}

export function useAuthFlow({ status, refresh, showToast, setLoadingAction, t }: AuthFlowDeps): AuthFlow {
	const [aliasInput, setAliasInput] = useState('');
	const [addingAccount, setAddingAccount] = useState(false);
	const [authCodeInput, setAuthCodeInput] = useState('');
	const [addProxyInput, setAddProxyInput] = useState('');
	const flowStartedRef = useRef(false);

	const safeMessage = (code?: string): string => {
		const key = `auth.code.${code ?? ''}` as AgyLocaleKey;
		return code && key in en ? t(key) : t('api.genericError');
	};

	useEffect(() => {
		if (!addingAccount || !flowStartedRef.current) return;
		const pa = status?.poolAuth;
		if (!pa) return;
		if (pa.phase === 'done') {
			flowStartedRef.current = false;
			setAddingAccount(false);
			setAuthCodeInput('');
			setAliasInput('');
			setAddProxyInput('');
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
			if (res.browserOpened) {
				showToast(t('auth.browserOpened'), 'info');
			} else {
				showToast(t('auth.browserManual'), 'warn');
			}
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
			setAuthCodeInput('');
			setAliasInput('');
			setAddProxyInput('');
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
		setAuthCodeInput('');
		setAliasInput('');
		setAddProxyInput('');
		setAddingAccount(false);
		await refresh();
	};

	const poolAuth = status?.poolAuth;
	const flowPhase = poolAuth?.phase ?? 'idle';
	const flowActive = flowPhase === 'waiting' || flowPhase === 'exchanging';

	return {
		addingAccount,
		setAddingAccount,
		aliasInput,
		setAliasInput,
		addProxyInput,
		setAddProxyInput,
		authCodeInput,
		setAuthCodeInput,
		safeMessage,
		handleBeginAddAccount,
		handleCompleteAddAccount,
		handleCancelAddAccount,
		poolAuth,
		flowPhase,
		flowActive,
	};
}
