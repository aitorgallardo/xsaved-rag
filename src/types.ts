export interface BookmarkLite {
  id: string;
  text: string;
  author: string;
  notes?: string;
  tags: string[];
  createdAt: string;
  bookmarkedAt: string;
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
