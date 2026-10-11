# Product

## Register

product

## Users

LumaForge serves photographers, creators, and camera hobbyists who shoot RAW but do not want to live inside a professional grading suite for every photo.
They usually want a convenient finished JPEG: one file in, a controlled look, a trustworthy comparison, and an export that does not require account setup, application installation, native helpers, license activation, or cloud upload.

Secondary users are technically curious photographers who understand LUTs enough to bring their own `.cube` files, but not enough to want every color-management failure mode exposed as a free-form node graph.

## Product Purpose

LumaForge is a browser-local RAW finishing lab.
Its core promise is simple: make a RAW-to-LUT workflow feel safe, immediate, and portable while keeping the color contract explicit.

The product is not trying to replace DaVinci Resolve, Lightroom, Capture One, or a full RAW development cockpit.
Professional tools are designed to obey the operator, even when gamma, log curve, gamut, and LUT output are mismatched.
LumaForge narrows the workflow so ordinary users can get a good straight-out result without accidentally building an invalid color pipeline.

For camera-log LUTs, the product expectation is scene-referred preview and export: RAW enters a standard scene-linear space, is transformed into the LUT's declared input gamut and transfer, then returns through the declared output contract before final photo output.

Success means a user can open the page on a modern browser, drop a single RAW file, see a useful preview quickly, pick a look from a LUT catalog (whose entries usually carry their own contract) or bring a `.cube` LUT with a declared contract, compare original and processed output, and export a full-resolution JPEG when the source and graph can be reproduced safely.

On a phone the same workflow stays photo-first rather than becoming a smaller desktop: the editing tools sit in a bottom dock, compare is a lens on the photo, Export is an action in the top bar, and the More menu offers only actions and facts that are real for the loaded file.
An interrupted export is never resumed or restarted on its own; the next export the user starts simply takes a safer plan.

## Brand Personality

Calibrated, protective, photographic.

The brand should feel like a quiet print lab with a very good color technician behind the counter.
It is precise without being cold, approachable without becoming playful, and opinionated without sounding condescending.
It should give users confidence that the pipeline is doing the careful work they would otherwise have to understand themselves.

## Anti-references

- Do not mimic a professional grading-suite interface with dark panels, dense node graphs, scopes, and unlimited knobs.
- Do not use generic SaaS landing-page patterns: hero metrics, repeated icon cards, purple gradients, or centered template stacks.
- Do not hide behind glassmorphism, bokeh, decorative blobs, or vague “AI-powered” visual language.
- Do not present unsafe freedom as a feature.
  The product advantage is fewer dangerous choices, not more exposed controls.
- Do not leave template-era attribution, placeholder copy, or component-gallery content on product-facing surfaces.

## Design Principles

1. Guardrails over knobs.
   Every control should prevent an avoidable color-science mistake or make the pipeline state clearer.
2. Show the image, then show the contract.
   Visual comparison sells the value, but the contract rail explains why the result can be trusted.
3. Browser-local is a product promise.
   Copy and UI should reinforce no upload, no account, no native helper, and no license friction.
4. Fail closed with plain language.
   If export is unsafe or unsupported, say what boundary failed rather than silently changing resolution or color intent.
5. Editorial confidence, tool restraint.
   Marketing surfaces can be bold and photographic; product surfaces should inherit the same palette, typography, and contract language while keeping density useful.

## Accessibility & Inclusion

Target WCAG AA contrast for all production UI.
Do not encode safety state with color alone; pair color with text, icons, or disabled-state explanations.
Respect `prefers-reduced-motion`; use motion as light orientation, not as a requirement to understand the workflow.
Keep buttons and drop targets large enough for touch when the browser and source file workflow allow mobile use, while making a desktop browser with WebGPU the supported baseline; browsers without WebGPU fall back to the slower CPU preview.
