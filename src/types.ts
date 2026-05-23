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
  distance: number;
  rank: number;
}
