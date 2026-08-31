# Admin Layout Bug Analysis: Codes Management Page Content Issue

## Issue Description

After the sidebar refactoring, the "兑换码管理" (Redeem Codes Management) page content may appear lost or not rendering correctly.

## Root Cause Analysis

### 1. Dead CSS Rules Remain After Refactoring

The old `.tabs`, `.tab`, and `.content` CSS rules are still present in the stylesheet but are no longer used by any HTML elements:

```css
/* DEAD CODE - no element uses class "tabs" anymore */
.tabs {
  display: flex;
  padding: 0 32px;
  border-bottom: 2px solid #e8e8e8;
  background: #fff;
}
/* DEAD CODE - no element uses class "tab" anymore */
.tab { ... }
.tab:hover { ... }
.tab.active { ... }

/* DEAD CODE - replaced by .main-content */
.content { padding: 24px 32px; max-width: 1200px; }
```

While dead CSS doesn't directly cause rendering issues, it adds unnecessary bloat and can cause confusion when debugging.

### 2. max-width Constraint on .main-content

The `.main-content` class inherited `max-width: 1200px` from the old `.content` design:

```css
.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 1200px;  /* PROBLEM: limits content width */
}
```

**Impact**: On a 1920px viewport, the sidebar takes 220px, leaving 1700px. But `max-width: 1200px` restricts the content to only 1200px, creating 500px of wasted empty space on the right. This makes the layout look broken and disconnected.

### 3. flex: 1 Conflict with max-width

`flex: 1` tells the browser to expand the element to fill available space, but `max-width: 1200px` contradicts this. The browser resolves this by:
- Growing `.main-content` to fill available space (flex: 1)
- But stopping at 1200px (max-width)
- Result: content area is 1200px wide with unused space on the right

### 4. Panel Visibility Mechanism

The codes panel visibility is controlled by CSS classes:

```css
.panel { display: none; }
.panel.active { display: block; }
```

```html
<div class="panel" id="panel-codes">  <!-- hidden by default -->
```

The `switchTab('codes')` function correctly adds the `active` class to `panel-codes`:

```javascript
function switchTab(tab) {
  // Removes active from all panels
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  // Adds active to the target panel
  document.getElementById('panel-' + tab).classList.add('active');
  if (tab === 'codes') loadCodes();
}
```

**Conclusion**: The panel visibility logic is correct. The content is not actually "lost" - it renders correctly when the tab is selected. The perceived issue is likely the cramped layout caused by the `max-width` constraint.

### 5. layout flex Container Interaction

The layout structure is:

```
body (flex column, min-height: 100vh)
├── header
├── desc-banner
├── stats-bar
├── .layout (flex row, flex: 1, min-height: 0)
│   ├── .sidebar (width: 220px, no flex)
│   └── .main-content (flex: 1, max-width: 1200px)
└── modals
```

The `min-height: 0` on `.layout` is necessary for the flex child to shrink below its content height. Without it, the layout could overflow the viewport. This is correctly set.

### 6. overflow-y: auto on .main-content

```css
.main-content { overflow-y: auto; }
```

This creates an independent scroll container inside the main content area. When the content (e.g., a long table) exceeds the viewport height, only the main-content area scrolls while the sidebar remains fixed. This is the correct behavior for an admin panel layout.

## Summary

| Issue | Severity | Status |
|-------|----------|--------|
| Dead CSS (.tabs, .tab, .content) | Low | Needs cleanup |
| max-width: 1200px on .main-content | Medium | Causes layout constraint |
| flex: 1 + max-width conflict | Medium | Wasted horizontal space |
| Panel visibility logic | None | Works correctly |
| overflow-y: auto scroll | None | Correct behavior |

The codes management page content is NOT actually lost. The HTML elements (`panel-codes`, `codesTable`, toolbar) are all present and correctly structured. The JavaScript `loadCodes()` function correctly populates the table. The `switchTab('codes')` function correctly shows the panel. The perceived "content loss" is most likely caused by the `max-width: 1200px` constraint making the content area appear cramped and visually disconnected from the sidebar on wider screens.