<script lang="ts">
  import { page } from '$app/stores';
  import { BookOpen, DatabaseZap, ExternalLink, Layers3, Menu, Server, TrendingUp, X } from 'lucide-svelte';

  let mobileOpen = false;

  const navLinks = [
    { label: 'Markets', href: '/#markets', description: 'dashboard market rows' },
    { label: 'Categories', href: '/categories', description: 'frontend category overview' },
    { label: 'Exchanges', href: '/#exchanges', description: 'dashboard exchange CTAs' },
    { label: 'Status', href: '/status', description: 'runtime product route' },
    { label: 'API Proof', href: '/api', description: 'frontend API explorer' }
  ];

  $: pathname = $page.url.pathname;

  function isActive(href: string) {
    if (href === '/#markets' || href === '/#exchanges') return pathname === '/';
    return pathname === href;
  }

  function closeMobile() {
    mobileOpen = false;
  }
</script>

<header class="sticky top-0 z-40 border-b border-white/10 bg-[#07110f]/90 text-[#f4f1e8] shadow-2xl backdrop-blur-xl">
  <div class="og-noise"></div>
  <div class="relative mx-auto flex min-h-20 max-w-[1500px] items-center gap-4 px-4">
    <button
      class="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/5 text-[#f4f1e8] lg:hidden"
      type="button"
      aria-label={mobileOpen ? 'Close route navigation menu' : 'Open route navigation menu'}
      aria-expanded={mobileOpen}
      aria-controls="route-navigation-menu"
      on:click={() => (mobileOpen = !mobileOpen)}
    >
      {#if mobileOpen}<X size={18} />{:else}<Menu size={18} />{/if}
    </button>

    <a class="group flex shrink-0 items-center gap-3" href="/" on:click={closeMobile}>
      <span class="relative grid size-11 place-items-center rounded-2xl border border-[#b8ff4d]/40 bg-[#b8ff4d] text-sm font-black text-[#07110f] shadow-[0_0_30px_rgba(184,255,77,0.28)]">
        OG
        <span class="absolute -right-1 -top-1 size-3 rounded-full bg-[#ffbf47]"></span>
      </span>
      <span>
        <span class="block text-[24px] font-black leading-none tracking-[-0.04em]">OpenGecko</span>
        <span class="block text-[10px] font-black uppercase tracking-[0.3em] text-[#91a59a]">Control Room routes</span>
      </span>
    </a>

    <nav class="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm font-black text-[#cbd8d0] lg:flex" aria-label="Route polish surfaces">
      {#each navLinks as link}
        <a
          class={isActive(link.href)
            ? 'rounded-full bg-[#b8ff4d] px-4 py-2 text-[#07110f]'
            : 'rounded-full px-4 py-2 hover:bg-white/10 hover:text-white'}
          href={link.href}
        >
          {link.label}
        </a>
      {/each}
    </nav>

    <div class="ml-auto hidden items-center gap-2 rounded-2xl border border-[#b8ff4d]/20 bg-[#b8ff4d]/10 px-4 py-3 text-xs font-black uppercase tracking-[0.16em] text-[#b8ff4d] md:flex">
      <DatabaseZap size={15} /> Product routes stay frontend-owned
    </div>
  </div>

  {#if mobileOpen}
    <nav id="route-navigation-menu" class="relative border-t border-white/10 bg-[#07110f] px-4 py-3 lg:hidden" aria-label="Mobile route polish surfaces">
      <div class="grid gap-3 text-sm font-black text-[#f4f1e8]">
        {#each navLinks as link}
          <a class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3" href={link.href} on:click={closeMobile}>
            <span class="flex items-center gap-2">
              {#if link.label === 'Markets'}<TrendingUp size={16} />{:else if link.label === 'Categories'}<Layers3 size={16} />{:else if link.label === 'Status'}<Server size={16} />{:else if link.label === 'API Proof'}<BookOpen size={16} />{:else}<ExternalLink size={16} />{/if}
              {link.label}
            </span>
            <span class="mt-1 block text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a]">{link.description}</span>
          </a>
        {/each}
      </div>
    </nav>
  {/if}
</header>
