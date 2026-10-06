# Bugs Found Through Playwright Testing

## Critical Issues

### 1. **File Editor Not Loading After File Selection**
- **Status**: CRITICAL
- **Description**: When a file is uploaded and clicked, the editor doesn't render in the editor-host
- **Affected Features**: Docx Editor, Text Editor, Code Editor
- **Test Evidence**: `tests/e2e/my-features.spec.ts` - test "docx toolbar has undo/redo buttons" fails
- **Root Cause**: Likely issue with editor mounting or state management in AppShell.ts
- **Fix Required**: Check `openFile()` method in AppShell.ts - verify editor is being correctly instantiated and mounted

### 2. **CodeMirror Find Dialog Not Appearing**
- **Status**: CRITICAL
- **Description**: Keyboard shortcut Ctrl+F doesn't open the search panel
- **Affected Features**: Code Editor Find Functionality (E.3)
- **Test Evidence**: `tests/e2e/my-features.spec.ts` - test "CodeMirror search panel is styled" fails
- **Root Cause**: CodeMirror's searchKeymap might not be properly wired, or editor lost focus before opening search
- **Fix Required**: Verify that openSearch() is being called and that focus is maintained

### 3. **Docx Page Smooth Scroll Not Working**
- **Status**: MEDIUM
- **Description**: Smooth scrolling CSS on docx-page causes timeout when evaluated
- **Affected Features**: DocxEditor (A.1, A.6)
- **Test Evidence**: `tests/e2e/my-features.spec.ts` - test "page has smooth scrolling CSS" times out
- **Root Cause**: Possible CSS conflict or the scroll-behavior property not applying correctly
- **Fix Required**: Check docx-page CSS - verify scroll-behavior: smooth is not conflicting with other styles

### 4. **Auth Bar Regex Issue in Tests**
- **Status**: LOW (Test Issue)
- **Description**: Header text regex matches multiple elements in strict mode
- **Affected Features**: None - this is a test issue
- **Fix Required**: Update test selector to target specific element (e.g., `.brand-accent` or `.brand-mark`)

## Medium Priority Issues

### 5. **Inspector/AI Mutual Exclusivity Not Fully Tested**
- **Status**: NEEDS VERIFICATION
- **Description**: While toggle works, the AI panel `close()` method may not exist
- **Affected Features**: General UI (inspector/AI exclusivity)
- **Recommendation**: Verify aiPanel object has close() or toggle() methods
- **Fix Required**: Check if aiPanel needs additional method or different toggle approach

### 6. **Image Editor Opacity Default Value**
- **Status**: LOW
- **Description**: Opacity slider might not show correct initial value if layer.opacity is undefined
- **Affected Features**: Image Editor (G.2)
- **Fix Required**: Ensure opacity defaults to 1.0 when layer.opacity is undefined

## Passing Tests (Working Features)

✅ Auth bar shows profile or sign in button
✅ Inspector button exists and toggles  
✅ AI button exists
✅ Find button visible in docx toolbar
✅ Modal inputs are styled
✅ Mermaid iframe loads properly

## Test Files Created

1. `tests/e2e/features.spec.ts` - Comprehensive feature tests
2. `tests/e2e/my-features.spec.ts` - Bug hunting tests with detailed assertions
3. `tests/e2e/smoke.spec.ts` - Updated with correct header text

## How to Reproduce

Run tests:
```bash
npm run dev &
npx playwright test tests/e2e/my-features.spec.ts
```

## Next Steps

1. **Fix file editor mounting** - Debug why editors aren't rendering
2. **Fix CodeMirror find** - Verify keyboard handler and focus management
3. **Fix docx scrolling** - Check CSS for conflicts
4. **Verify mutual exclusivity** - Test inspector/AI toggle together
5. **Test all features** - Run full Playwright suite after fixes
