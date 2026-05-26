// Curated snapshot of the Orthogonal "Discover APIs" catalog. This is a static,
// hand-maintained list (not fetched live) mirroring Orthogonal's own Discover
// page. Endpoint counts and descriptions are a point-in-time snapshot; refresh
// manually as the upstream catalog evolves. Each API is assigned ONE primary
// category from CATALOG_CATEGORIES based on its description; genuinely ambiguous
// entries are left uncategorized (undefined) so they only surface under "All".

export interface CatalogApi {
  name: string;
  description: string;
  endpoints: number;
  tier: "verified" | "community";
  category?: string;
}

// Render order for the category filter chips. "All" is the implicit default and
// is handled by the UI; the rest map to CatalogApi.category values.
export const CATALOG_CATEGORIES = [
  "All",
  "Browser Automation",
  "People Search",
  "Company Search",
  "Email Finder",
  "AI Search",
  "Web Search",
  "Identity Verification",
  "Brand Data",
  "Weather",
  "Video",
  "Scrape",
  "LLM",
  "Prediction Markets",
  "Image",
] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export const VERIFIED_APIS: CatalogApi[] = [
  { name: "Olostep API", endpoints: 12, tier: "verified", category: "AI Search", description: "AI way to search the web, extract structured data in real time, and build datasets." },
  { name: "Serper", endpoints: 12, tier: "verified", category: "Web Search", description: "Google Search API by Serper: fast, reliable access to 12 Google search types." },
  { name: "Apollo API", endpoints: 9, tier: "verified", category: "People Search", description: "Apollo.io API for people and company enrichment, search, and prospecting." },
  { name: "ContactOut", endpoints: 7, tier: "verified", category: "Email Finder", description: "Find anyone's email and phone number. Sales and recruitment intelligence with LinkedIn." },
  { name: "Scrape Creators", endpoints: 107, tier: "verified", category: "Scrape", description: "Social media data extraction API covering 22+ platforms including TikTok, Instagram." },
  { name: "Fiber AI API", endpoints: 92, tier: "verified", category: "People Search", description: "Reach anyone on the planet with verified contacts. Highly accurate contact data." },
  { name: "Fundable", endpoints: 13, tier: "verified", category: "Company Search", description: "Real-time venture capital deals, startup, and investor data. Search funding rounds." },
  { name: "Company Enrich", endpoints: 29, tier: "verified", category: "Company Search", description: "Comprehensive company and people data enrichment, search, and lead generation API." },
  { name: "Brand.dev API", endpoints: 13, tier: "verified", category: "Brand Data", description: "Personalize your product with logos, colors, and company info from any domain." },
  { name: "Tomba API", endpoints: 20, tier: "verified", category: "Email Finder", description: "Email finding and verification API." },
  { name: "Seltz", endpoints: 1, tier: "verified", category: "Web Search", description: "Context-engineered web search API. Search the web and return matching documents." },
  { name: "Coresignal", endpoints: 21, tier: "verified", category: "Company Search", description: "Business data intelligence platform providing company, employee, and job data." },
  { name: "Aviato", endpoints: 25, tier: "verified", category: "Company Search", description: "Comprehensive company and person intelligence platform. Enrich companies and people." },
  { name: "Notte", endpoints: 15, tier: "verified", category: "Browser Automation", description: "Browser automation API for AI agents. Start browser sessions, run AI agents, scrape." },
  { name: "Crustdata", endpoints: 7, tier: "verified", category: "Company Search", description: "B2B data platform providing firmographic data, growth metrics, and people data." },
  { name: "Nyne.ai", endpoints: 28, tier: "verified", category: "People Search", description: "People and company intelligence platform. Find contacts, enrich profiles, get socials." },
  { name: "Linkup API", endpoints: 2, tier: "verified", category: "Web Search", description: "Web search engine for AI apps. Connect your AI application to the internet." },
  { name: "Tavily API", endpoints: 6, tier: "verified", category: "Web Search", description: "Real-time search, extraction, and web crawling through a single, secure API." },
  { name: "Ocean.io", endpoints: 8, tier: "verified", category: "Company Search", description: "Company and people search, enrichment, lookup, and discovery." },
  { name: "People Data Labs", endpoints: 6, tier: "verified", category: "People Search", description: "Access the world's largest people and company dataset. Enrich, search, clean." },
  { name: "PredictLeads", endpoints: 23, tier: "verified", category: "Company Search", description: "Company intelligence API: job openings, news events, financing events." },
  { name: "AgentMail", endpoints: 21, tier: "verified", category: "Email Finder", description: "Programmatic email for AI agents. Create inboxes, send/receive emails, manage threads." },
  { name: "CaptainData", endpoints: 9, tier: "verified", category: "People Search", description: "People and company enrichment, search, and discovery." },
  { name: "Baseten Model APIs", endpoints: 2, tier: "verified", category: "LLM", description: "High-performance inference platform for running open-source LLMs." },
  { name: "Sixtyfour API", endpoints: 4, tier: "verified", category: "People Search", description: "Build custom research agents to enrich people and company data." },
  { name: "Openmart", endpoints: 4, tier: "verified", category: "Company Search", description: "Local business search, enrichment, and lead intelligence. 30M+ US/CA/AU businesses." },
  { name: "Edges", endpoints: 42, tier: "verified", category: "People Search", description: "LinkedIn automation actions for data extraction, search, and discovery." },
  { name: "Context.dev", endpoints: 22, tier: "verified", category: "Scrape", description: "Retrieve context data from any website. Web scraping, brand retrieval, AI extraction." },
  { name: "Voygr", endpoints: 1, tier: "verified", category: "Company Search", description: "Validate whether a business exists at a given address and whether it is currently open." },
  { name: "Andi Search API", endpoints: 1, tier: "verified", category: "AI Search", description: "AI Search for the next generation." },
  { name: "Precip AI", endpoints: 17, tier: "verified", category: "Weather", description: "Hyperlocal weather: highly accurate, site-specific rainfall accumulation data." },
  { name: "Didit API", endpoints: 6, tier: "verified", category: "Identity Verification", description: "All-in-one identity platform. Fast identity verification." },
  { name: "Riveter API", endpoints: 5, tier: "verified", category: "Web Search", description: "Power your product with data from the web. Agents manage web search and extraction." },
  { name: "Tako", endpoints: 6, tier: "verified", category: "AI Search", description: "Knowledge search engine that visualizes the world's data." },
  { name: "Influencers Club", endpoints: 22, tier: "verified", category: "People Search", description: "Creator discovery, enrichment, and audience analytics across Instagram/YouTube/TikTok." },
  { name: "Serper Scrape", endpoints: 1, tier: "verified", category: "Scrape", description: "Web scraping powered by Serper: extract clean text, markdown, or HTML from any URL." },
  { name: "OpenFunnel", endpoints: 32, tier: "verified", category: "Company Search", description: "GTM intelligence platform. Search companies by traits/signals, enrich accounts." },
  { name: "ScrapeGraphAI", endpoints: 11, tier: "verified", category: "Scrape", description: "Scrape URLs, extract structured data with LLMs, search and scrape top results, crawl." },
  { name: "Happenstance", endpoints: 2, tier: "verified", category: "People Search", description: "Person research API. Submit a description of someone and get back a detailed profile." },
];

export const COMMUNITY_APIS: CatalogApi[] = [
  { name: "Exa API", endpoints: 7, tier: "community", category: "AI Search", description: "Search engine made for AIs." },
  { name: "Hunter", endpoints: 8, tier: "community", category: "Email Finder", description: "Finding and verifying professional email addresses. Domain search." },
  { name: "Textbelt API", endpoints: 2, tier: "community", description: "SMS API to send and receive text messages." },
  { name: "Perplexity API", endpoints: 5, tier: "community", category: "AI Search", description: "AI answer engine. Fast, cheap, citation-backed answers." },
  { name: "Parallel API", endpoints: 12, tier: "community", category: "Web Search", description: "A web API purpose-built for AIs. Powering millions of daily requests." },
  { name: "Tavus API", endpoints: 2, tier: "community", category: "Video", description: "Create a Conversational Video Interface (CVI)." },
  { name: "Z.ai API", endpoints: 10, tier: "community", category: "LLM", description: "GLM series large language models, including GLM-4.5 and GLM-4.6." },
  { name: "Jina Search Foundation API", endpoints: 1, tier: "community", category: "AI Search", description: "Search foundation for multilingual and multimodal AI." },
  { name: "Dome API", endpoints: 17, tier: "community", category: "Prediction Markets", description: "Comprehensive access to prediction market data across multiple markets." },
  { name: "Valyu API", endpoints: 13, tier: "community", category: "AI Search", description: "Search API that lets your AI access high-quality information." },
  { name: "Logo.dev", endpoints: 1, tier: "community", category: "Brand Data", description: "Brand search and company data API." },
  { name: "SearchAPI", endpoints: 18, tier: "community", category: "Web Search", description: "Real-time SERP scraping: YouTube, Google, Amazon, TikTok, Instagram, and more." },
  { name: "Nano Banana", endpoints: 1, tier: "community", category: "Image", description: "Generate and edit images using Google's image models." },
  { name: "Nano Banana 2", endpoints: 1, tier: "community", category: "Image", description: "Generate and edit images using Google's image models (v2)." },
  { name: "OpenAI", endpoints: 4, tier: "community", category: "LLM", description: "OpenAI API for text generation, embeddings, and more." },
  { name: "ElevenLabs", endpoints: 6, tier: "community", category: "Video", description: "AI voice generation, text-to-speech, and audio APIs." },
];
