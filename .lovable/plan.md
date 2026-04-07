

## Fix Plan: Mobile View, 12hr Time, and Email Sync Issues

### Problems from Screenshot
1. **Email HTML cut off on right** — Netflix email content is clipped, not fitting mobile screen. Current CSS `transform: scale(0.85)` doesn't work properly — leaves dead space and still clips.
2. **24hr time format** — Shows "23:10:00" instead of "11:10 PM". Two places: inbox list (line 1082) and email detail view (line 1124).
3. **New incoming emails not fetching** — IMAP sync runs every 10s but takes 25s+ per call, so it's always overlapping/blocked by `isFetchingRef`.
4. **Not all month's emails showing** — Backend processes newest-first but re-fetches already-cached UIDs too (line 176: `orderedUids = [...uncachedUids, ...alreadyCachedUids]`), wasting time on old emails instead of focusing on new ones only.

### Plan

**1. Fix mobile email HTML rendering**
- Remove `transform: scale(0.85)` — it causes the clipping issue
- Instead, force all tables to `width: 100% !important; max-width: 100% !important` on mobile
- Add `table-layout: fixed` and `overflow-wrap: break-word` to prevent overflow
- Set container width explicitly with proper padding

**2. Switch to 12-hour time format**
- Inbox list time (line 1082): Add `hour12: true` to `toLocaleTimeString`
- Email detail date (line 1124): Use `toLocaleString` with `hour12: true` and proper India locale format like "07/04/2026, 11:10 PM"

**3. Fix IMAP sync efficiency**
- In `fetch-emails/index.ts`: Remove re-fetching of already cached UIDs (line 176) — ONLY fetch `uncachedUids`
- This makes each sync cycle much faster since it only downloads NEW emails
- With fewer emails to process per cycle, the 25s timeout won't be hit

**4. Adjust sync interval to avoid overlap**
- Keep 10s cache refresh (instant DB read)
- Change IMAP sync to 15s interval instead of 10s, giving enough gap for the shorter sync to complete

### Files to Change

- `src/App.tsx` — Time format (2 lines), mobile CSS (remove scale, add proper table constraints), sync interval
- `supabase/functions/fetch-emails/index.ts` — Remove re-fetching cached UIDs (line 176), only process `uncachedUids`

### Technical Details

Time format fix:
```
// Line 1082 (inbox list)
{ hour: "2-digit", minute: "2-digit", hour12: true }

// Line 1124 (email detail)  
new Date(selectedEmail.date).toLocaleString("en-IN", { 
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: true 
})
```

Mobile CSS fix:
```css
@media (max-width: 480px) {
  .gmail-style-content table { 
    width: 100% !important; 
    max-width: 100% !important; 
    table-layout: fixed !important; 
  }
  .gmail-style-content td, .gmail-style-content th {
    max-width: 100vw !important;
    overflow: hidden !important;
  }
}
```

Backend: Line 176 change from `[...uncachedUids, ...alreadyCachedUids]` to just `uncachedUids`.

