# References

Place domain-specific and user-provided reference materials here.
All CoBolt agents check this folder before falling back to web search or training knowledge.

## What to put here

- **Design guidelines** — brand colors, typography, spacing rules, design principles
- **Logos & assets** — brand logos, icons, and image assets (PNG, SVG, JPG)
- **API documentation** — PDFs or markdown for libraries not covered by context7
- **Domain knowledge** — business rules, regulatory requirements, compliance docs
- **Style guides** — coding standards, naming conventions, architecture decision records
- **Wireframes & mockups** — UI/UX reference screenshots or design exports
- **Integration specs** — third-party API contracts, webhook schemas, data formats

## Supported formats

| Format     | Support | Notes                                  |
|------------|---------|----------------------------------------|
| Markdown   | Best    | Fastest for agents to parse             |
| PDF        | Good    | Up to 20 pages per read (use sections)  |
| Plain text | Good    | .txt, .csv, .json, .yaml                |
| Images     | Good    | PNG, JPG, SVG — agents can view these   |
| HTML       | Partial | Readable but noisy with markup          |

## Organization

Organize however makes sense for your project:

```
references/
  design/          — brand guidelines, logos, color palettes
  api-docs/        — library/framework documentation
  domain/          — business rules, compliance, regulations
  wireframes/      — UI mockups, screenshots, design exports
```

## How agents use this folder

1. **Research agent** checks here after context7 MCP, before web search
2. **UX designer** reads design guidelines and brand assets
3. **Frontend dev** references design tokens, logos, and component specs
4. **All agents** check here for domain-specific knowledge during session startup
