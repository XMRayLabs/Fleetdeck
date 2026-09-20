// One-shot memory only. Never persist terminal contents in URL/localStorage.
let draft: { context: string; targets: number[]; user: number; expires: number } | undefined;
export function setAiDraft(context: string, targets: number[], user: number) {
    draft = { context: context.slice(0, 64000), targets, user, expires: Date.now() + 60000 };
}
export function takeAiDraft(user: number) {
    const value = draft; draft = undefined;
    return value?.user === user && value.expires > Date.now() ? value : undefined;
}
