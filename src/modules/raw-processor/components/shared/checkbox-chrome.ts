/**
 * The paint of a checkbox on the /raw chrome, desktop and mobile alike: a
 * lift-soft well with a cool hairline at rest, Lab Green once checked. Paint
 * only; each consumer sets its own size for its pointer.
 */
export const CHECKBOX_CHROME =
  'border border-[oklch(0.96_0.006_255/0.24)] bg-[oklch(0.96_0.006_255/0.06)] data-[state=checked]:border-lf-green data-[state=checked]:bg-lf-green data-[state=checked]:text-lf-surface'
