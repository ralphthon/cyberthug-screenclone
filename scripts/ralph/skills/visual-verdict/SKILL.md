---
name: visual-verdict
description: "Compare original vs generated screenshots using vision-based analysis. Returns structured verdict with score, differences, and actionable suggestions. Use after rendering generated code to evaluate clone quality. Triggers on: compare screenshots, visual verdict, evaluate clone, check similarity."
user-invocable: true
---

# Visual Verdict — Vision-Based Clone Quality Evaluator

Compares an original screenshot against a generated clone screenshot using vision-based image understanding. Returns a structured JSON verdict with quantitative score, categorical match assessments, specific differences, and actionable improvement suggestions.

This is the **primary feedback signal** for the Ralph image loop. Unlike pixel-diff (pixelmatch), this evaluates "is this the same web service/product" rather than "are these identical pixels".

---

## When To Use

- After rendering generated HTML/CSS/JS to a screenshot
- To evaluate how close a clone attempt is to the original
- As the loop termination condition (score >= 90 = pass)
- To get specific, actionable feedback for the next iteration

---

## How To Use

### Prerequisites
- Original reference screenshot(s) available (provided via `--analyze-image` or `--images-dir`)
- Generated code rendered to screenshot (use browser/puppeteer to capture)

### Invocation

Compare the original reference image against your generated screenshot. Analyze both images and return a JSON verdict.

**You MUST return the verdict as a JSON code block with this exact schema:**

```json
{
  "score": <0-100>,
  "layout_match": <true/false>,
  "color_match": <true/false>,
  "component_match": <true/false>,
  "text_match": <true/false>,
  "responsive_match": <true/false>,
  "differences": [
    "<specific difference 1>",
    "<specific difference 2>"
  ],
  "suggestions": [
    "<actionable code fix 1>",
    "<actionable code fix 2>"
  ],
  "verdict": "<pass|close|fail>",
  "reasoning": "<1-2 sentence summary>"
}
```

### Evaluation Criteria

Judge as **"same web service/product"**, NOT pixel-identical:

1. **Layout Structure** (`layout_match`): Same visual hierarchy? Header/nav/content/footer in same positions? Same grid/flex structure? Same content density?
2. **Color Palette** (`color_match`): Background, text, accent, border colors match within reasonable tolerance? Same light/dark theme?
3. **Component Inventory** (`component_match`): Same UI components present? Buttons, cards, lists, inputs, icons? Nothing major missing or extra?
4. **Text Content** (`text_match`): Headlines, labels, navigation text match? Placeholder/sample content acceptable but structure should match.
5. **Responsive Feel** (`responsive_match`): Same responsive behavior at the captured viewport? Same breakpoint feel?

### Score Interpretation

| Range | Verdict | Meaning |
|-------|---------|---------|
| 0-30  | `fail`  | Fundamentally different — wrong structure entirely |
| 30-60 | `fail`  | Structure recognizable but major issues |
| 60-80 | `close` | Similar but notable differences remain |
| 80-90 | `close` | Very similar, minor polish needed |
| 90+   | `pass`  | Production-quality clone — matches the original service |

### Writing Good Differences

Be specific and actionable:
- ❌ "Colors are different" 
- ✅ "Header background is #2d2a3e but should be #1e1b2e (too light)"
- ❌ "Layout is wrong"
- ✅ "Content container is full-width but should be max-width 1200px centered"

### Writing Good Suggestions

Reference actual CSS/HTML fixes:
- ✅ "Add `max-width: 1200px; margin: 0 auto;` to the main content wrapper"
- ✅ "Change nav background from `bg-gray-800` to `bg-[#ff6600]`"
- ✅ "Add the missing login link: `<a href='/login' class='float-right'>login</a>` in the header"

---

## Integration With Ralph Loop

In `prompt.md` / `CLAUDE.md`, add this to the iteration workflow:

```
After implementing changes:
1. Render the generated HTML in a browser
2. Capture a screenshot of the rendered page
3. Invoke $visual-verdict to compare original vs generated screenshot
4. Read the verdict:
   - If verdict is "pass" (score >= 90): mark story as passes: true
   - If verdict is "close" or "fail": use differences[] and suggestions[] to plan next fixes
5. Log the verdict to progress.txt
```

---

## Example Output

```json
{
  "score": 68,
  "layout_match": false,
  "color_match": true,
  "component_match": true,
  "text_match": false,
  "responsive_match": true,
  "differences": [
    "Content container is full-width edge-to-edge; original uses centered fixed-width with side margins",
    "Header missing Y icon box on left and login link on right",
    "Only 5 story items shown; original has 30+ creating much denser content",
    "Header text appears heavier/larger than original",
    "Story metadata missing 'hide' links"
  ],
  "suggestions": [
    "Wrap page in centered container: max-width: 85%; margin: 0 auto",
    "Add Y icon box and right-aligned login link to header",
    "Render at least 20 story items to match content density",
    "Reduce header font-size from 11pt to 10pt and font-weight to normal for nav links",
    "Add 'hide' link after 'comments' in each story's metadata row"
  ],
  "verdict": "close",
  "reasoning": "Core HN structure captured (orange nav, ranked story list) but key layout constraints and several signature components are missing. Feels like an HN-style page rather than a close reproduction."
}
```
