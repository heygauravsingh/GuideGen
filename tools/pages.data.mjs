// The content behind /solutions/* and /compare/*.
//
// Kept apart from the generator so the writing can be edited without reading a line
// of template code, and so `--check` has one thing to diff against.
//
// ## Solutions
//
// Guidejar's equivalents are Internal Wiki, Product Marketing, Lead Generation, User
// Onboarding and Sales Enablement. All five are here, because a visitor who arrives
// looking for their own job has to find it. **The first two are not theirs and cannot
// be**: reproducing a bug needs the API log, and handing a workflow to a model needs
// the text export. Those lead, because they are the pages nobody else can write.
//
// ## Comparisons
//
// Every claim about a competitor is either something they publish on their own
// pricing page or something structural about how their product works. **No invented
// numbers, no invented quotes, and no claim that a competitor is bad** — a comparison
// page that reads as a hit piece is worth less than none, and the honest version is
// stronger here because the free/local-first position genuinely wins most of these.
// Where a rival is better at something, it says so.

export const SOLUTIONS = [
  {
    slug: "reproduce-a-bug",
    nav: "Reproduce a bug",
    eyebrow: "Engineering & QA",
    title: "Turn “it didn’t work” into something an engineer can start on",
    lede:
      "A bug report is usually a sentence and a screenshot, and the first reply is always the same three questions. " +
      "GuideGen answers them before they are asked — every click, and every API call those clicks fired.",
    who: "QA engineers, support engineers, and anyone who files the ticket somebody else has to reproduce.",
    points: [
      ["Every request, with what came back",
       "Turn on the API capture before you record. Each step carries the calls it fired — method, path, status — and " +
       "you can copy any one of them as a cURL with the headers and the body. <b>POST /api/orders → 500</b> is a " +
       "starting point; “the save button is broken” is not."],
      ["You do not have to reproduce it twice",
       "Catch-up capture means the recording can start after the bug did. Arm the dashboard once, work normally, and " +
       "when something breaks take the last two minutes — screenshots, steps and network log intact."],
      ["Credentials are masked before anything is stored",
       "Authorization headers, session cookies, API keys and query-string values are replaced with a mask in the page " +
       "and again in the extension. The cURL documents the call. It cannot replay it."],
      ["Nothing is uploaded",
       "Response bodies can hold real customer records, which is exactly why this tier is off by default and why the " +
       "whole capture stays on your machine. Attach the file to the ticket yourself, or hand the text to a model."],
    ],
    cta: "Record your next bug",
  },
  {
    slug: "hand-a-workflow-to-an-ai",
    nav: "Hand a workflow to an AI",
    eyebrow: "AI handoff",
    title: "Stop describing the process to your assistant. Show it.",
    lede:
      "Explaining a ten-step internal flow to a model in prose is slower than doing it, and the model still guesses " +
      "at the parts you left out. Do it once instead, and paste the whole thing.",
    who: "Anyone automating an internal process, writing a runbook a model will read, or briefing an agent.",
    points: [
      ["The context a model needs, not the pictures it doesn’t",
       "Copy for AI puts the workflow on your clipboard as plain Markdown: every step, the action it was, and the URL " +
       "and page title it happened on, grouped by page. It is text, so you can read exactly what you are about to send."],
      ["It works with whatever you already use",
       "No integration, no API key, no MCP server to run. It pastes into Claude, ChatGPT, Gemini, Copilot, an IDE, a " +
       "Jira ticket or a plain note. Nothing is sent anywhere until you paste it yourself."],
      ["The API log travels with it",
       "If you captured the network calls, they come along — so a model debugging a failure sees the request that " +
       "failed, not just the sentence describing it."],
      ["Honest about what it is",
       "GuideGen documents a workflow. It does not replay or automate one, and the handoff is text rather than a " +
       "script. What you get is the description a model needs to help; the doing is still yours."],
    ],
    cta: "Try the handoff",
  },
  {
    slug: "internal-wiki",
    nav: "Internal wiki & SOPs",
    eyebrow: "Operations",
    title: "The SOP nobody had time to write, written while you worked",
    lede:
      "Process documentation loses to the actual work every single week. The only version that survives is the one " +
      "that took no extra time to make.",
    who: "Ops leads, IT, finance and anyone maintaining the internal wiki everybody complains is out of date.",
    points: [
      ["Do the task, keep the guide",
       "Click through the process the way you were going to anyway. Every click becomes a numbered step with a " +
       "screenshot cropped to the control you pressed and the instruction written for you."],
      ["It lands where your docs already live",
       "One paste puts the formatted guide, screenshots and all, into Notion, Confluence or Google Docs. Or export " +
       "Markdown for a wiki, a PDF for a training pack, or slides for an induction."],
      ["Redact before it leaves",
       "Drag over anything that should not be in a shared doc — customer names, order ids, salary figures. It is " +
       "pixelated into the image itself, so no unredacted original is ever uploaded."],
      ["Update the link, not the document",
       "Re-publish a guide and the page updates in place, so the link already sitting in your handbook is never stale."],
    ],
    cta: "Document your first process",
  },
  {
    slug: "user-onboarding",
    nav: "User onboarding",
    eyebrow: "Customer success",
    title: "Show new users the path instead of describing it",
    lede:
      "The first week decides whether somebody keeps using your product. A walkthrough they can click through beats " +
      "a paragraph telling them where to click.",
    who: "Customer success, onboarding and implementation teams.",
    points: [
      ["A walkthrough, not a wall of text",
       "A published guide can be read as a scrolling document or clicked through one step at a time, with a live " +
       "target on the screenshot showing exactly what to press next."],
      ["Embed it where they already are",
       "One snippet drops the guide into your help centre, your docs or the product itself — with none of our " +
       "branding around it."],
      ["Narrated, in a voice you did not have to record",
       "Export the same guide as a 1080p narrated video for people who would rather watch. The voice is synthesised " +
       "on your own machine, so no script of your product ever goes to a speech service."],
      ["Free, so you can make one per feature",
       "Unlimited guides, no watermark and no per-seat cost, which means onboarding content can cover the long tail " +
       "instead of only the top three flows."],
    ],
    cta: "Build an onboarding guide",
  },
  {
    slug: "customer-support",
    nav: "Customer support",
    eyebrow: "Support",
    title: "Answer it once, send the link every time after that",
    lede:
      "Support volume is mostly the same twenty questions. Each one is worth a guide, and a guide is worth writing " +
      "only if it takes two minutes.",
    who: "Support leads, help-centre owners and anyone answering the same ticket for the fifth time.",
    points: [
      ["Reply with a link instead of a paragraph",
       "Publish a guide and get a link anyone can open — no account, no install. Any single step can be linked on " +
       "its own, so “look at step 7” is a link rather than an instruction."],
      ["It reads properly on a phone",
       "Screenshots crop to the part of the screen that matters rather than shrinking a whole desktop window until " +
       "the text is unreadable, and any image opens full-screen and zooms."],
      ["Build the answer from what already happened",
       "Catch-up capture turns the last two minutes into a guide, so the reproduction you just did for yourself " +
       "becomes the article for everyone else."],
      ["Put it in the help centre you already run",
       "Embed the guide with one snippet, or paste it straight into Zendesk, Intercom articles, Notion or Confluence."],
    ],
    cta: "Answer one for the last time",
  },
  {
    slug: "product-marketing",
    nav: "Product marketing",
    eyebrow: "Marketing",
    title: "Show the feature working, without booking a designer",
    lede:
      "A launch needs the product on screen. Recording it yourself takes a morning and looks like it; this takes the " +
      "length of the flow.",
    who: "Product marketers and founders shipping features nobody has seen yet.",
    points: [
      ["A narrated video from the same recording",
       "1080p, one slide per step, the click ringed, a voice reading each step aloud, five speaking paces. It comes " +
       "out as an .mp4, so it drops straight into a launch post, a deck or a social clip."],
      ["An interactive walkthrough for the page",
       "Embed the clickable version next to the copy so a reader can move through the feature themselves rather than " +
       "watching someone else use it."],
      ["Slides, for the deck you will be asked for anyway",
       "One slide per step as a .pptx — the same recording, no rebuild."],
      ["No watermark, on the free version",
       "Nothing in the corner of your launch asset advertising the tool that made it."],
    ],
    cta: "Record your next launch",
  },
  {
    slug: "sales-demos",
    nav: "Sales demos",
    eyebrow: "Sales",
    title: "Leave behind the demo you just gave",
    lede:
      "The call goes well and then the champion has to re-explain your product to four colleagues who were not on it. " +
      "Send the walkthrough instead.",
    who: "Founders selling, account executives and sales engineers.",
    points: [
      ["A leave-behind that survives the forward",
       "A link anyone can open, with your name and the flow you actually showed. It reads on a phone, and any step " +
       "can be linked on its own."],
      ["Tailor it without re-recording",
       "Edit any step’s wording, drop steps that were not relevant to them, and re-publish to the same link."],
      ["Redact the account you demoed on",
       "Blur customer names or figures from the demo tenant before it goes anywhere, burned into the image itself."],
      ["Where it stops, honestly",
       "There is no lead-capture form, no viewer analytics and no branching by answer. If a gated interactive demo " +
       "with per-viewer variables is the job, a dedicated demo tool is the right buy — this is the fast, free way to " +
       "leave a walkthrough behind."],
    ],
    cta: "Make a leave-behind",
  },
];

export const COMPARISONS = [
  {
    slug: "guidegen-vs-guidejar",
    nav: "vs Guidejar",
    rival: "Guidejar",
    title: "GuideGen vs Guidejar",
    lede:
      "Guidejar is a polished, well-built documentation platform with a help centre, analytics and a team plan. " +
      "GuideGen is a capture tool that runs on your machine and costs nothing. The honest question is which job you " +
      "are doing.",
    theyWin: [
      "A hosted help centre on your own domain, with search, branding and SSO",
      "Viewer analytics, forms and feedback on published guides",
      "Conditional branching and per-viewer variables for interactive demos",
      "A desktop app that records native applications, not just the browser",
      "AI translation, voice cloning and talking-head video",
    ],
    weWin: [
      ["Catch-up capture", "Turn the last two minutes into a guide after the fact. Guidejar, like every other tool here, needs you to have pressed record first."],
      ["API requests and responses", "Every call a step fired, as a copyable cURL with what came back. Nothing comparable exists in their product."],
      ["Nothing leaves your machine", "Narration is synthesised locally and guides upload only when you publish one. Their Chrome Web Store listing declares that they handle user activity and website content, as any cloud product must."],
      ["Free, unlimited, unwatermarked", "Their free plan stops at five guides and keeps a watermark; MP4 export sits in a paid tier, and so do Markdown and HTML export."],
    ],
    verdict:
      "If you need a branded help centre on your own domain with analytics and seats for a team, buy Guidejar — that " +
      "is a real product and GuideGen does not do it. If you want to capture a workflow (including one you already " +
      "did), keep it off other people’s servers, and pay nothing, GuideGen is the better fit.",
  },
  {
    slug: "guidegen-vs-scribe",
    nav: "vs Scribe",
    rival: "Scribe",
    title: "GuideGen vs Scribe",
    lede:
      "Scribe is the best known tool in this category and the reason most people know step-by-step capture exists. " +
      "It is also a per-seat SaaS whose free tier is deliberately narrow.",
    theyWin: [
      "The largest install base and the most mature editor in the category",
      "Team workspaces, shared folders and enterprise controls",
      "A desktop capture app for native applications",
    ],
    weWin: [
      ["Catch-up capture", "Scribe records forward from the moment you press start. GuideGen can build the guide out of the last two minutes you already worked."],
      ["The network log", "Neither Scribe nor anything else in this category captures the API calls behind each step."],
      ["Exports without a subscription", "PDF, Markdown, HTML, slides and a narrated MP4 are all free here, unlimited and unwatermarked."],
      ["Local by default", "Recording, editing, narration and every export happen in your browser; a guide is uploaded only when you publish it."],
    ],
    verdict:
      "Scribe is the safer choice for a large team that wants shared folders, admin controls and a vendor with a " +
      "support contract. GuideGen is the better choice if the guide is for you, an engineer, or a model — and if you " +
      "would rather the screens never left your laptop.",
  },
  {
    slug: "guidegen-vs-tango",
    nav: "vs Tango",
    rival: "Tango",
    title: "GuideGen vs Tango",
    lede:
      "Tango is aimed at teams rolling out software, with in-app guidance that walks a user through a live product. " +
      "That is a different job from documenting a workflow you just did.",
    theyWin: [
      "In-app guidance layered over your live product",
      "Team analytics on how guides are being followed",
      "Deep enterprise rollout and change-management features",
    ],
    weWin: [
      ["It does not need to be installed for the reader", "A published GuideGen guide is a link anyone opens — no extension, no account, no product access."],
      ["Capture the past", "Catch-up capture has no equivalent in Tango."],
      ["The engineering use case", "The API log makes GuideGen useful for reproducing a bug, which in-app guidance does not attempt."],
      ["Free", "No seats, no minimum, no watermark."],
    ],
    verdict:
      "If your problem is guiding users inside your own product while they use it, Tango is built for that and " +
      "GuideGen is not. If your problem is explaining a workflow to somebody who is not in the product yet, GuideGen " +
      "is faster and free.",
  },
  {
    slug: "guidegen-vs-guidde",
    nav: "vs Guidde",
    rival: "Guidde",
    title: "GuideGen vs Guidde",
    lede:
      "Guidde leads with AI video: capture a flow and get a narrated video documentation piece, with cloud voices in " +
      "many languages. GuideGen also makes a narrated video — the difference is where the voice runs.",
    theyWin: [
      "A large library of cloud voices and languages, including translation",
      "Team workspaces and viewer analytics",
      "A more elaborate video editor",
    ],
    weWin: [
      ["The voice runs on your computer", "GuideGen bundles its neural voice, so the script of your internal process is never sent to a speech service. That is why the download is larger, and it is the trade on purpose."],
      ["The video is free and unwatermarked", "1080p, five speaking paces, exported as .mp4."],
      ["Catch-up capture and the API log", "Neither exists in Guidde."],
      ["Six other formats from the same recording", "HTML, Markdown, PDF, slides, a Notion paste and a text handoff for a model."],
    ],
    verdict:
      "Guidde is the better buy if you need many languages and cloud voice variety. GuideGen is the better fit if the " +
      "content is internal and you would rather it stayed that way.",
  },
  {
    slug: "guidegen-vs-supademo",
    nav: "vs Supademo",
    rival: "Supademo",
    title: "GuideGen vs Supademo",
    lede:
      "Supademo is an interactive demo platform built for go-to-market teams — branching, variables, lead capture and " +
      "analytics on who watched what. GuideGen is a documentation and capture tool that happens to have a walkthrough view.",
    theyWin: [
      "Conditional branching and per-viewer personalisation",
      "Lead capture and demo analytics built for a sales funnel",
      "A demo editor designed for polishing a pitch",
    ],
    weWin: [
      ["Every document format, free", "PDF, Markdown, HTML, slides, a narrated MP4 and a text handoff — Supademo is a demo tool, not a documentation one."],
      ["The API log", "For a demo tool this is irrelevant; for the QA and support-engineering work GuideGen is also built for, it is the whole point."],
      ["Catch-up capture", "No equivalent."],
      ["Nothing is uploaded until you publish", "Supademo is a hosted demo platform by design."],
    ],
    verdict:
      "For a sales team running gated, personalised, measured demos, Supademo is the right category of product and " +
      "GuideGen does not compete with it. For documenting how something works and handing it to a person, an " +
      "engineer or a model, GuideGen does more and costs nothing.",
  },
];
