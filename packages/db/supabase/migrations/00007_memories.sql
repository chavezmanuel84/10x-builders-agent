create extension if not exists vector;

create table if not exists public.memories (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  type              text not null check (type in ('episodic', 'semantic', 'procedural')),
  content           text not null,
  embedding         vector(1536) not null,
  retrieval_count   integer not null default 0,
  created_at        timestamptz not null default now(),
  last_retrieved_at timestamptz
);

alter table public.memories enable row level security;

create policy "Users can view own memories"
  on public.memories for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own memories"
  on public.memories for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own memories"
  on public.memories for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists memories_user_id_created_at_idx
  on public.memories (user_id, created_at desc);

create index if not exists memories_embedding_hnsw_idx
  on public.memories using hnsw (embedding vector_cosine_ops);

create or replace function public.match_memories(
  p_user_id uuid,
  query_embedding vector(1536),
  match_count int default 8,
  match_threshold float default 0.70
)
returns table (
  id uuid,
  user_id uuid,
  type text,
  content text,
  retrieval_count int,
  created_at timestamptz,
  last_retrieved_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    m.id,
    m.user_id,
    m.type,
    m.content,
    m.retrieval_count,
    m.created_at,
    m.last_retrieved_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.memories m
  where
    m.user_id = p_user_id
    and 1 - (m.embedding <=> query_embedding) >= match_threshold
  order by m.embedding <=> query_embedding
  limit greatest(1, least(match_count, 8));
$$;
