---
name: feedback
description: Use at the end of a Helix session to capture how it went — whether the role/stance was right, whether pushback was appropriate, and whether the answer was trustworthy.
---

# Helix session feedback

When the user invokes this skill, collect four answers conversationally (in the user's language;
Korean shown here):

1. **role** — 제가 상황에 맞는 역할/태도로 응했나요? (예/아니오)
2. **pushback** — 반박·이견 제시가 적절했나요? (예/아니오)
3. **trust** — 제 답을 신뢰할 수 있었나요? (예/아니오)
4. **reason** — 한 줄 코멘트 (특히 가장 큰 실패가 무엇이었는지).

Reflect the answers back in one short summary so the user can correct them. Persisting the
feedback to Helix's audit log is wired once the engine build lands (Phase 5); until then,
summarize and stop. Do not fabricate a saved-confirmation.
