# Mobile file viewer

Approved in conversation: mobile only, full viewport over the main app bar, one compact row shared by source, diff and native rendered Markdown. Desktop keeps its existing controls and layout.

The row contains Back, filename, view mode, More and Close. Back returns to the tree; Close returns to the app. Secondary actions (search, comparison, refresh, wrap, file actions and metadata) move into a dismissible overlay, keeping their existing handlers and dirty-draft guards. View modes remain explicit and do not add headers. Keep 44px touch targets and device safe areas. On phones the document receives all remaining height, including in landscape. Do not change comment storage, sending or desktop presentation.

Approaches considered: stacked compact rows, auto-hiding controls on scroll, and a single full-screen row. The user chose the single row and explicitly limited it to mobile. This consolidates document controls like Zed's editor toolbar (https://zed.dev/docs/reference/all-settings), using the existing app controls rather than copying its design.

Baseline at 390×844 and 320×844: main toolbar 145px, ordinary diff header ends at 206px; Markdown adds 51px view controls and a 129px reader header, putting its body at 325px. Target: one roughly 56–61px toolbar plus safe-area insets, no wrapping or extra Markdown header.
