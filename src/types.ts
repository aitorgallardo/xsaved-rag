export interface MediaItem {
  /** image | video | repost | article | card | link */
  type: string;
  urls: string[];
  metadata?: Record<string, any>;
}

export interface BookmarkLite {
  id: string;
  text: string;
  author: string;
  notes?: string;
  tags: string[];
  createdAt: string;
  bookmarkedAt: string;
  media: MediaItem[];
  /** Text distilled from media by the enrichment pass (captions, quoted tweets, card titles). */
  mediaSummary?: string;
  /** Which vision model produced the caption(s), if any. */
  mediaSummaryModel?: string;
}

export interface SearchHit {
  bookmarkId: string;
  author: string;
  text: string;
  notes?: string;
  tags: string[];
  rank: number;
  distance?: number;
  keywordScore?: number;
}

export interface SearchFilters {
  author?: string;
  tags?: string[];
  bookmarkedAfter?: string;
  bookmarkedBefore?: string;
}
