import { useCallback, useState } from "react";

/**
 * Field errors that wait for the person: a field is checked when they leave it
 * (blur), never while they type, and every field is checked when they press
 * the submit button. Messages say what to do, not what is wrong.
 *
 *   const form = useBlurErrors();
 *   <TextInput onBlur={form.blur("name")} error={form.show("name", name.trim() ? null : "Type the item's name.")} />
 *   <Button onClick={() => { if (!form.submit(valid)) return; save(); }} loading={busy}>
 */
export function useBlurErrors() {
  const [touched, setTouched] = useState<Record<string, true>>({});
  const [all, setAll] = useState(false);
  const blur = useCallback((key: string) => () => setTouched((cur) => (cur[key] ? cur : { ...cur, [key]: true })), []);
  /** The message, once the field has been left or submit was pressed. */
  const show = (key: string, message: string | null | undefined | false) => ((all || touched[key]) && message ? message : undefined);
  /** Call on submit. Shows every error and moves focus to the first one; returns whether to go on. */
  const submit = (valid: boolean) => {
    if (valid) return true;
    setAll(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
    return false;
  };
  const reset = () => { setTouched({}); setAll(false); };
  return { blur, show, submit, reset };
}
