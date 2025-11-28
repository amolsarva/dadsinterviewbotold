# Fallback Text Inventory

This file is the single source of truth for every hard-coded fallback phrase in the app. Update the JSON block below and run `pnpm fallback:sync` to regenerate the TypeScript helpers that power the runtime code. Strings may contain named placeholders wrapped in braces (for example `{DATE}` or `{DETAIL}`) that the code replaces at runtime. Each entry includes a quick reference to the modules that consume it so you can review usage in context.

```json
{
  "sessionTitle": {
    "defaultFromDate": "Session on {DATE}"
  },
  "introFlow": {
    "returningGreetingWithTitles": "Welcome back—I'm keeping your stories about {TITLES} safe for you.",
    "returningGreetingDefault": "Welcome back—your archive is open and I'm ready whenever you are.",
    "firstTimeGreeting": "Hi, I'm DadsBot. I'm here to help you capture the memories you want to keep.",
    "latestDetailReminder": "The last thing you shared was about {DETAIL}.",
    "noDetailPromise": "I'll remember every detail you share from this moment on.",
    "returningInvitation": "When you are ready, …",
    "firstSessionInvitation": "When you feel ready, …",
    "defaultContinuationQuestion": "Where would you like to pick up the story?",
    "firstSessionQuestion": "Would you start by telling me the first memory you'd like to save together?",
    "clientFallback": "Welcome back. I remember everything you have trusted me with. Tell me one new detail you would like to explore now."
  },
  "questions": {
    "detailGuard": "When you think about {DETAIL}, what else stands out now?",
    "promptPool": [
      "Could you set the scene for me—where were you when this memory took place?",
      "Who else shared that moment with you, and what were they doing?",
      "What was the very first thing you noticed as it unfolded?",
      "What feeling rushed in right away?",
      "Is there a small sound or scent that still brings it back to you?",
      "Was there an object in the room that now holds extra meaning for you?",
      "What was happening just a few moments before everything began?",
      "How did the light or weather color that scene for you?",
      "What voices or music drifted through the background?",
      "Was there a taste or texture that anchors the memory for you?"
    ],
    "finalGuard": "Tell me one detail you have not shared with me yet."
  },
  "askTurn": {
    "firstSessionGreeting": "Hi, I'm DadsBot. I'm here to help you save the stories and small details your family will want to revisit. When it feels right, would you start with a memory you'd like me to remember?",
    "returningWithHighlight": "Welcome back. I'm still holding onto what you told me about {HIGHLIGHT}. Let's add another chapter to your archive.",
    "returningDefault": "Welcome back—your story archive is open and I'm keeping track of everything you've trusted me with.",
    "providerException": "Who else was there? Share a first name and one detail about them."
  }
}
```

## Quick lookup

- **Session title default:** "Session on {DATE}".  
  Modules: `lib/data.ts`, `app/api/history/route.ts`, `app/page.tsx`
- **Intro greetings:**
  - Returning with titles → "Welcome back—I'm keeping your stories about {TITLES} safe for you."  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`, `app/page.tsx`
  - Returning default → "Welcome back—your archive is open and I'm ready whenever you are."  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`, `app/page.tsx`
  - First-time greeting → "Hi, I'm DadsBot. I'm here to help you capture the memories you want to keep."
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`, `app/page.tsx`
- **Intro reminders & promises:**
  - Latest detail reminder → "The last thing you shared was about {DETAIL}."  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`
  - No-detail promise → "I'll remember every detail you share from this moment on."  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`
- **Intro invitations & questions:**
  - Returning invitation → "When you are ready, …"  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`
  - First-session invitation → "When you feel ready, …"  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`
  - Default continuation question → "Where would you like to pick up the story?"  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`
  - First-session question → "Would you start by telling me the first memory you'd like to save together?"  
    Modules: `lib/data.ts`, `app/api/session/[id]/intro/route.ts`
  - Client intro fallback → "Welcome back. I remember everything you have trusted me with. Tell me one new detail you would like to explore now."  
    Modules: `app/page.tsx`
- **Question prompts:**
  - Detail-aware guard → "When you think about {DETAIL}, what else stands out now?"  
    Modules: `lib/question-memory.ts`
  - Sensory prompt pool → see JSON list above.  
    Modules: `lib/question-memory.ts`
  - Final guard question → "Tell me one detail you have not shared with me yet."  
    Modules: `lib/question-memory.ts`
- **Ask-turn fallbacks:**
  - First-session greeting → "Hi, I'm DadsBot. I'm here to help you save the stories and small details your family will want to revisit. When it feels right, would you start with a memory you'd like me to remember?"
    Modules: `app/api/ask-audio/route.ts`, `app/page.tsx`
  - Returning with highlight → "Welcome back. I'm still holding onto what you told me about {HIGHLIGHT}. Let's add another chapter to your archive."  
    Modules: `app/api/ask-audio/route.ts`, `app/page.tsx`
  - Returning default → "Welcome back—your story archive is open and I'm keeping track of everything you've trusted me with."  
    Modules: `app/api/ask-audio/route.ts`, `app/page.tsx`
  - Provider exception prompt → "Who else was there? Share a first name and one detail about them."  
    Modules: `app/api/ask-audio/route.ts`

## Reference Notes

### Session Title Defaults
- `{DATE}` → localized date string derived from the session creation time.

### Intro Flow Fallbacks
- `{TITLES}` → up to three remembered session titles joined with commas and `and`.
- `{DETAIL}` → the most recent remembered user detail from prior turns.

### Question Fallbacks
- `{DETAIL}` → a shortened version of the latest remembered detail.

### Ask Turn Fallback Replies
- `{HIGHLIGHT}` → a remembered highlight detail from earlier in the archive.

Run `pnpm fallback:sync` after editing the JSON to update the generated helpers in `lib/fallback-texts.generated.ts`.
