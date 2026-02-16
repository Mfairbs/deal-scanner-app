# NSW Commercial Property Deal Scanner

A web application for analyzing and scoring commercial property listings to identify distressed opportunities in New South Wales.

## Features

- **Automated Distress Scoring**: Analyzes property listings based on:
  - Distress keywords (mortgagee, receivership, must sell, etc.)
  - Days on market (DOM)
  - Vacancy indicators

- **Interactive Dashboard**:
  - Filter by priority, property type, suburb, price range
  - Sort and search capabilities
  - Expandable property details
  - Visual analytics of distress signals

- **CSV Import/Export**: Upload property listings and export scored results

## Tech Stack

- React + Vite
- Tailwind CSS
- Recharts for data visualization
- PapaParse for CSV handling

## Getting Started

### Prerequisites
- Node.js 18+

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

## Usage

1. Upload a CSV file containing property listings
2. The app will automatically score properties based on distress signals
3. Filter and analyze results
4. Export scored properties to CSV

## Deployment

This app is deployed on GitHub Pages: [https://mfairbs.github.io/deal-scanner-app/](https://mfairbs.github.io/deal-scanner-app/)
