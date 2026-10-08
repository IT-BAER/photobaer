//! Max-flow / min-cut with the search-tree algorithm of Boykov and Kolmogorov ("An Experimental
//! Comparison of Min-Cut/Max-Flow Algorithms for Energy Minimization in Vision", PAMI 2004):
//! a source tree and a sink tree grow until they touch, the path is augmented, and the orphans
//! it leaves are re-adopted; the trees are reused instead of rebuilt per path.

use std::collections::VecDeque;

const NONE: u32 = u32::MAX;
const TERMINAL: u32 = u32::MAX - 1;
const FREE: u8 = 0;
const SOURCE: u8 = 1;
const SINK: u8 = 2;

/// A graph with terminal links per node and paired directed edges; edge `e ^ 1` is the reverse of `e`.
pub struct Graph {
    head: Vec<u32>,
    next: Vec<u32>,
    to: Vec<u32>,
    cap: Vec<f32>,
    // Residual terminal capacity: > 0 from the source, < 0 to the sink.
    tr: Vec<f32>,
    flow: f64,
    tree: Vec<u8>,
    // The edge from a tree node to its parent, TERMINAL for a root, NONE when free or orphaned.
    parent: Vec<u32>,
    ts: Vec<u32>,
    dist: Vec<u32>,
    active: VecDeque<u32>,
    queued: Vec<bool>,
    orphans: VecDeque<u32>,
    time: u32,
}

impl Graph {
    /// `edges`: the expected number of `add_edge` calls.
    pub fn with_edges(n: usize, edges: usize) -> Graph {
        Graph {
            head: vec![NONE; n],
            next: Vec::with_capacity(edges * 2),
            to: Vec::with_capacity(edges * 2),
            cap: Vec::with_capacity(edges * 2),
            tr: vec![0.0; n],
            flow: 0.0,
            tree: vec![FREE; n],
            parent: vec![NONE; n],
            ts: vec![0; n],
            dist: vec![0; n],
            active: VecDeque::new(),
            queued: vec![false; n],
            orphans: VecDeque::new(),
            time: 0,
        }
    }

    /// Adds capacity from the source and to the sink; the part both share flows at once.
    pub fn add_tweights(&mut self, i: usize, source: f32, sink: f32) {
        let (mut s, mut t) = (source, sink);
        let d = self.tr[i];
        if d > 0.0 {
            s += d;
        } else {
            t -= d;
        }
        self.flow += s.min(t) as f64;
        self.tr[i] = s - t;
    }

    /// An edge i -> j with capacity `cap` and j -> i with `rev_cap`.
    pub fn add_edge(&mut self, i: usize, j: usize, cap: f32, rev_cap: f32) {
        let e = self.to.len() as u32;
        self.to.push(j as u32);
        self.cap.push(cap);
        self.next.push(self.head[i]);
        self.head[i] = e;
        self.to.push(i as u32);
        self.cap.push(rev_cap);
        self.next.push(self.head[j]);
        self.head[j] = e + 1;
    }

    /// Whether node `i` is on the source side of the minimum cut (valid after `maxflow`).
    pub fn in_source(&self, i: usize) -> bool {
        self.tree[i] == SOURCE
    }

    fn activate(&mut self, i: u32) {
        if !self.queued[i as usize] {
            self.queued[i as usize] = true;
            self.active.push_back(i);
        }
    }

    fn orphan(&mut self, i: u32) {
        self.parent[i as usize] = NONE;
        self.orphans.push_back(i);
    }

    // Residual capacity in the tree's flow direction for an edge e = p -> q with p in `tree`.
    fn open(&self, tree: u8, e: u32) -> bool {
        if tree == SOURCE { self.cap[e as usize] > 0.0 } else { self.cap[(e ^ 1) as usize] > 0.0 }
    }

    pub fn maxflow(&mut self) -> f64 {
        for i in 0..self.tr.len() {
            let t = self.tr[i];
            if t != 0.0 {
                self.tree[i] = if t > 0.0 { SOURCE } else { SINK };
                self.parent[i] = TERMINAL;
                self.dist[i] = 1;
                self.activate(i as u32);
            }
        }
        while let Some(bridge) = self.grow() {
            self.time += 1;
            self.augment(bridge);
            while let Some(p) = self.orphans.pop_front() {
                self.adopt(p);
            }
        }
        self.flow
    }

    // Grows the trees from the active nodes; the edge from the source tree into the sink tree.
    fn grow(&mut self) -> Option<u32> {
        while let Some(&p) = self.active.front() {
            let pu = p as usize;
            let t = self.tree[pu];
            if t != FREE {
                let mut e = self.head[pu];
                while e != NONE {
                    let q = self.to[e as usize] as usize;
                    if self.open(t, e) {
                        if self.tree[q] == FREE {
                            self.tree[q] = t;
                            self.parent[q] = e ^ 1;
                            self.ts[q] = self.ts[pu];
                            self.dist[q] = self.dist[pu] + 1;
                            self.activate(q as u32);
                        } else if self.tree[q] != t {
                            // p stays at the queue front: it may have more edges to the other tree.
                            return Some(if t == SOURCE { e } else { e ^ 1 });
                        } else if self.ts[q] <= self.ts[pu] && self.dist[q] > self.dist[pu] {
                            self.parent[q] = e ^ 1;
                            self.ts[q] = self.ts[pu];
                            self.dist[q] = self.dist[pu] + 1;
                        }
                    }
                    e = self.next[e as usize];
                }
            }
            self.active.pop_front();
            self.queued[pu] = false;
        }
        None
    }

    fn augment(&mut self, bridge: u32) {
        let b = bridge as usize;
        let mut d = self.cap[b];
        let mut x = self.to[b ^ 1] as usize;
        loop {
            let pe = self.parent[x];
            if pe == TERMINAL {
                d = d.min(self.tr[x]);
                break;
            }
            d = d.min(self.cap[(pe ^ 1) as usize]);
            x = self.to[pe as usize] as usize;
        }
        x = self.to[b] as usize;
        loop {
            let pe = self.parent[x];
            if pe == TERMINAL {
                d = d.min(-self.tr[x]);
                break;
            }
            d = d.min(self.cap[pe as usize]);
            x = self.to[pe as usize] as usize;
        }

        self.cap[b] -= d;
        self.cap[b ^ 1] += d;
        x = self.to[b ^ 1] as usize;
        loop {
            let pe = self.parent[x];
            if pe == TERMINAL {
                self.tr[x] -= d;
                if self.tr[x] <= 0.0 {
                    self.orphan(x as u32);
                }
                break;
            }
            let (down, up) = ((pe ^ 1) as usize, pe as usize);
            self.cap[down] -= d;
            self.cap[up] += d;
            let next = self.to[up] as usize;
            if self.cap[down] <= 0.0 {
                self.orphan(x as u32);
            }
            x = next;
        }
        x = self.to[b] as usize;
        loop {
            let pe = self.parent[x];
            if pe == TERMINAL {
                self.tr[x] += d;
                if self.tr[x] >= 0.0 {
                    self.orphan(x as u32);
                }
                break;
            }
            let (up, down) = (pe as usize, (pe ^ 1) as usize);
            self.cap[up] -= d;
            self.cap[down] += d;
            let next = self.to[up] as usize;
            if self.cap[up] <= 0.0 {
                self.orphan(x as u32);
            }
            x = next;
        }
        self.flow += d as f64;
    }

    // Finds the orphan `p` a new parent in its tree whose path reaches the terminal, else frees it.
    fn adopt(&mut self, p: u32) {
        let pu = p as usize;
        let t = self.tree[pu];
        let (mut best, mut best_d) = (NONE, u32::MAX);
        let mut e = self.head[pu];
        while e != NONE {
            let q = self.to[e as usize] as usize;
            // Flow runs q -> p in the source tree and p -> q in the sink tree.
            let residual = if t == SOURCE { self.cap[(e ^ 1) as usize] } else { self.cap[e as usize] };
            if self.tree[q] == t && residual > 0.0 {
                let mut j = q;
                let mut d = 0u32;
                loop {
                    if self.ts[j] == self.time {
                        d += self.dist[j];
                        break;
                    }
                    d += 1;
                    let a = self.parent[j];
                    if a == TERMINAL {
                        self.ts[j] = self.time;
                        self.dist[j] = 1;
                        break;
                    }
                    if a == NONE {
                        d = u32::MAX;
                        break;
                    }
                    j = self.to[a as usize] as usize;
                }
                if d != u32::MAX {
                    if d < best_d {
                        best = e;
                        best_d = d;
                    }
                    let mut j = q;
                    let mut dd = d;
                    while self.ts[j] != self.time {
                        self.ts[j] = self.time;
                        self.dist[j] = dd;
                        dd -= 1;
                        j = self.to[self.parent[j] as usize] as usize;
                    }
                }
            }
            e = self.next[e as usize];
        }
        if best != NONE {
            self.parent[pu] = best;
            self.ts[pu] = self.time;
            self.dist[pu] = best_d + 1;
            return;
        }
        let mut e = self.head[pu];
        while e != NONE {
            let q = self.to[e as usize];
            let qu = q as usize;
            if self.tree[qu] == t {
                let residual = if t == SOURCE { self.cap[(e ^ 1) as usize] } else { self.cap[e as usize] };
                if residual > 0.0 {
                    self.activate(q);
                }
                let a = self.parent[qu];
                if a != TERMINAL && a != NONE && self.to[a as usize] == p {
                    self.orphan(q);
                }
            }
            e = self.next[e as usize];
        }
        self.tree[pu] = FREE;
    }
}
