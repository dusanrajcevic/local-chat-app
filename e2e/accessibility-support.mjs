function findAccessibilityIssues(root = globalThis.document) {
  const issues = [];
  const allWithIds = Array.from(root.querySelectorAll('[id]'));
  const idCounts = new Map();

  for (const element of allWithIds) {
    idCounts.set(element.id, (idCounts.get(element.id) || 0) + 1);
  }

  for (const [id, count] of idCounts) {
    if (count > 1) issues.push(`Duplicate id: #${id}`);
  }

  function referencedText(element, attribute) {
    const ids = String(element.getAttribute(attribute) || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return ids
      .map((id) => root.getElementById(id)?.textContent?.trim() || '')
      .join(' ')
      .trim();
  }

  function accessibleName(element) {
    const ariaLabel = String(element.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;

    const labelledBy = referencedText(element, 'aria-labelledby');
    if (labelledBy) return labelledBy;

    if (element.labels?.length) {
      const labelText = Array.from(element.labels)
        .map((label) => label.textContent?.trim() || '')
        .join(' ')
        .trim();
      if (labelText) return labelText;
    }

    const tagName = element.tagName?.toLowerCase();
    if (tagName === 'button' || tagName === 'a') return element.textContent?.trim() || '';
    if (tagName === 'img') return String(element.getAttribute('alt') || '').trim();
    return '';
  }

  for (const control of root.querySelectorAll('button, input, select, textarea')) {
    if (control.tagName?.toLowerCase() === 'input' && control.type === 'hidden') continue;
    if (!accessibleName(control)) {
      issues.push(`Control has no accessible name: ${control.tagName.toLowerCase()}#${control.id || '(no id)'}`);
    }
  }

  for (const dialog of root.querySelectorAll('[role="dialog"]')) {
    if (!accessibleName(dialog)) issues.push(`Dialog has no accessible name: #${dialog.id || '(no id)'}`);
    if (dialog.getAttribute('aria-modal') !== 'true') {
      issues.push(`Dialog is missing aria-modal="true": #${dialog.id || '(no id)'}`);
    }
  }

  for (const group of root.querySelectorAll('[role="group"]')) {
    if (!accessibleName(group)) issues.push(`Group has no accessible name: #${group.id || '(no id)'}`);
  }

  for (const element of root.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      if (!element.hasAttribute(attribute)) continue;
      const ids = String(element.getAttribute(attribute) || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) {
        if (!root.getElementById(id)) {
          issues.push(`${attribute} references missing #${id} from #${element.id || '(no id)'}`);
        }
      }
    }
  }

  return issues;
}

async function collectAccessibilityIssues(page) {
  return page.evaluate(findAccessibilityIssues);
}

export { findAccessibilityIssues, collectAccessibilityIssues };
