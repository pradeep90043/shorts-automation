---
name: browser-automation
description: Guidelines and helper functions for browser automation using visual screenshots, parallel DOM inspection, and state mapping.
---

# Browser Automation Guidelines

Use the following methodology when automating interactions with web pages or browser-based application extensions:

## Core Methodology

### Technique 1: Screenshot-First Visual Analysis
1. Take a screenshot of the current page.
2. Visually identify:
   - Main content areas (job listings, forms, etc.)
   - Side drawers and modals
   - Form fields and their positions
   - Buttons and interactive elements
   - Navigation elements
   - Any overlays or dialogs

### Technique 2: Parallel DOM Inspection
1. Inspect the DOM structure using JavaScript.
2. Extract:
   - All form fields with their types (text, radio, select, etc.)
   - Element references (for programmatic interaction)
   - CSS classes and IDs
   - Data attributes
   - Hidden/visible states
   - Parent-child relationships

---

## Workflow for Each Page Interaction

### Step 1: Discover Page Structure
Before taking any action:
1. Take a screenshot.
2. Get the DOM tree with reference IDs.
3. Compare visual layout with DOM structure.
4. Identify all interactive elements.

```javascript
function inspectPageElements() {
  return {
    forms: Array.from(document.querySelectorAll('form, [role="dialog"], [class*="drawer"]'))
      .map(el => ({
        selector: generateSelector(el),
        type: el.tagName,
        classes: el.className,
        id: el.id,
        visibleText: el.textContent.substring(0, 100),
        position: {
          top: el.getBoundingClientRect().top,
          left: el.getBoundingClientRect().left,
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height
        },
        isVisible: isElementVisible(el),
        children: getFormFields(el)
      })),
    
    formFields: Array.from(document.querySelectorAll(
      'input, select, textarea, button, [role="button"], [contenteditable]'
    )).map(el => ({
      name: el.name || el.id || el.className,
      type: el.type || el.tagName,
      value: el.value,
      required: el.required || el.getAttribute('aria-required'),
      placeholder: el.placeholder,
      options: el.tagName === 'SELECT' ? 
        Array.from(el.options).map(o => o.value) : null,
      classes: el.className,
      ref: generateRefId(el)
    }))
  };
}
```

### Step 2: Identify Drawer/Modal Structures
Specifically detect side drawers (like Naukri's questionnaire panel):

```javascript
function detectDrawerStructure() {
  const patterns = [
    '.nI-gNb-drawer',
    '[class*="drawer"]',
    '[class*="sidebar"]',
    '[role="dialog"]',
    '[class*="panel"]',
    '.modal, .modal-content',
  ];
  
  for (let selector of patterns) {
    const drawer = document.querySelector(selector);
    if (drawer && isElementVisible(drawer)) {
      return {
        element: drawer,
        selector: selector,
        structure: {
          overlay: document.querySelector('[class*="overlay"], [class*="backdrop"]'),
          closeButton: drawer.querySelector('[class*="close"], [aria-label*="close"]'),
          header: drawer.querySelector('[class*="header"], h1, h2, h3'),
          content: drawer.querySelector('[class*="content"], [class*="body"]'),
          fields: Array.from(drawer.querySelectorAll('input, select, textarea, button'))
            .map(f => ({
              name: f.name || f.id,
              type: f.type || f.tagName,
              currentValue: f.value,
              isVisible: isElementVisible(f),
              ref: f
            }))
        },
        cssStyles: {
          position: getComputedStyle(drawer).position,
          display: getComputedStyle(drawer).display,
          zIndex: getComputedStyle(drawer).zIndex,
          width: getComputedStyle(drawer).width,
          height: getComputedStyle(drawer).height,
          backgroundColor: getComputedStyle(drawer).backgroundColor,
          opacity: getComputedStyle(drawer).opacity,
          transform: getComputedStyle(drawer).transform,
          transition: getComputedStyle(drawer).transition
        }
      };
    }
  }
  return null;
}
```

### Step 3: Map Page State
Create a comprehensive page state object:

```javascript
function getPageState() {
  return {
    url: window.location.href,
    title: document.title,
    activeModals: Array.from(document.querySelectorAll('[class*="modal"], [class*="drawer"], [role="dialog"]'))
      .filter(isElementVisible)
      .map(m => m.className),
    forms: inspectPageElements().forms,
    currentlyVisibleFields: inspectPageElements().formFields.filter(f => f.isVisible),
    drawers: detectDrawerStructure(),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(isElementVisible)
      .map(b => ({
        text: b.textContent.trim(),
        classes: b.className,
        type: b.type || b.role,
        action: b.onclick ? 'has-onclick' : 'no-click-handler'
      }))
  };
}
```

### Step 4: Intelligent Form Interaction
Follow this precise execution flow:
1. Take screenshot to see current visual state.
2. Call `getPageState()` to map drawer/modal structures.
3. Fetch element references (e.g. ref_1, ref_2).
4. Inspect elements on visual/DOM states.
5. Fill form inputs using target selectors/references.
6. Verify outcome post-interaction using screenshot.

---

## Helper Utilities

```javascript
function isElementVisible(el) {
  if (!el) return false;
  return el.offsetParent !== null && 
         getComputedStyle(el).visibility !== 'hidden' &&
         getComputedStyle(el).display !== 'none';
}

function generateSelector(el) {
  if (el.id) return '#' + el.id;
  if (el.className) return '.' + el.className.split(' ').join('.');
  return el.tagName.toLowerCase();
}

function getFormFields(container) {
  return Array.from(container.querySelectorAll(
    'input, select, textarea, button, [role="button"]'
  )).map(f => ({
    name: f.name || f.id || f.className,
    label: container.querySelector(`label[for="${f.id}"]`)?.textContent || f.placeholder,
    type: f.type || f.tagName,
    visible: isElementVisible(f),
    required: f.required || f.getAttribute('aria-required') === 'true'
  }));
}
```
