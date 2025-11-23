
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// --- Constants & Config ---
const GRAVITY = 0.4;
const FLIGHT_POWER = -0.8;
const MAX_SPEED_Y = 8;
const INITIAL_SPEED = 6;
const SPAWN_RATE = 70; 
const GAME_COLORS = {
    bg: '#050510',
    player: '#00f3ff',
    playerShield: '#ffffff',
    ground: '#b026ff',
    obstacle: '#ff2a6d',
    coin: '#f1c40f',
    text: '#05d9e8'
};

// --- Audio Engine (Synth) ---
class AudioController {
    ctx: AudioContext | null = null;
    masterGain: GainNode | null = null;
    engineOsc: OscillatorNode | null = null;
    engineGain: GainNode | null = null;
    initialized = false;

    init() {
        if (this.initialized) return;
        try {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            this.ctx = new AudioContext();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.4;
            this.masterGain.connect(this.ctx.destination);
            this.initialized = true;
        } catch (e) {
            console.error("Audio init failed", e);
        }
    }

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    startEngine() {
        if (!this.ctx || !this.masterGain) return;
        if (this.engineOsc) return; // Already running

        this.engineOsc = this.ctx.createOscillator();
        this.engineGain = this.ctx.createGain();
        
        this.engineOsc.type = 'sawtooth';
        this.engineOsc.frequency.value = 50; // Low drone
        
        this.engineGain.gain.value = 0.05;
        
        this.engineOsc.connect(this.engineGain);
        this.engineGain.connect(this.masterGain);
        this.engineOsc.start();
    }

    modulateEngine(isThrusting: boolean) {
        if (!this.ctx || !this.engineOsc || !this.engineGain) return;
        const now = this.ctx.currentTime;
        if (isThrusting) {
            this.engineOsc.frequency.setTargetAtTime(80, now, 0.2);
            this.engineGain.gain.setTargetAtTime(0.1, now, 0.1);
        } else {
            this.engineOsc.frequency.setTargetAtTime(50, now, 0.5);
            this.engineGain.gain.setTargetAtTime(0.05, now, 0.5);
        }
    }

    stopEngine() {
        if (this.engineOsc) {
            try { this.engineOsc.stop(); } catch (e) {}
            this.engineOsc = null;
        }
    }

    playTone(freq: number, type: OscillatorType, duration: number, vol = 1, slideTo?: number) {
        if (!this.ctx || !this.masterGain) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        if (slideTo) {
            osc.frequency.exponentialRampToValueAtTime(slideTo, this.ctx.currentTime + duration);
        }
        
        gain.connect(this.masterGain);
        osc.connect(gain);
        
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    playJump() { /* Handled by engine modulation mostly, but can add a "whoosh" */ }
    playCoin() { this.playTone(1200, 'sine', 0.15, 0.4, 1800); }
    playCrash() { 
        this.playTone(100, 'sawtooth', 0.4, 0.8, 10); 
        this.playTone(50, 'square', 0.4, 0.8, 10);
    }
    playPowerup() { 
        this.playTone(400, 'sine', 0.3, 0.5, 800);
        setTimeout(() => this.playTone(800, 'sine', 0.3, 0.5, 1200), 100);
    }
}

const audio = new AudioController();

// --- Types ---
interface Entity { 
    id: number;
    x: number; 
    y: number; 
    width: number; 
    height: number; 
    type: 'ROCK' | 'LASER' | 'BIRD' | 'COIN' | 'SHIELD' | 'MAGNET' | 'SLOWMO'; 
    markedForDeletion: boolean;
    rotation?: number; // For visual effects
}

interface Particle {
    x: number; y: number; vx: number; vy: number; life: number; color: string; size: number;
}

const SkyRider = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number>(0);
    
    // Game State Refs (Mutable for loop performance)
    const state = useRef({
        isPlaying: false,
        isGameOver: false,
        score: 0,
        speed: INITIAL_SPEED,
        distance: 0,
        
        // Player
        px: 50,
        py: 200,
        pvy: 0,
        width: 40,
        height: 25,
        isThrusting: false,
        trail: [] as {x: number, y: number}[],
        
        // Powerups
        shieldTime: 0,
        magnetTime: 0,
        slowMoTime: 0,
        
        // World
        entities: [] as Entity[],
        particles: [] as Particle[],
        frameCount: 0,
        
        // Background
        bgOffset: 0
    });

    // React State for UI
    const [uiState, setUiState] = useState({
        view: 'START', // START, PLAYING, GAMEOVER
        score: 0,
        highScore: 0,
        powerups: [] as string[]
    });

    // Load Highscore
    useEffect(() => {
        const saved = localStorage.getItem('skyRiderHighScore');
        setUiState(s => ({ ...s, highScore: saved ? parseInt(saved) : 0 }));
    }, []);

    // --- Core Game Functions ---

    const startGame = () => {
        audio.init();
        audio.resume();
        audio.startEngine();

        state.current = {
            ...state.current,
            isPlaying: true,
            isGameOver: false,
            score: 0,
            speed: INITIAL_SPEED,
            distance: 0,
            px: 50,
            py: window.innerHeight / 2,
            pvy: 0,
            isThrusting: false,
            trail: [],
            shieldTime: 0,
            magnetTime: 0,
            slowMoTime: 0,
            entities: [],
            particles: [],
            frameCount: 0
        };

        setUiState(prev => ({ ...prev, view: 'PLAYING', score: 0, powerups: [] }));
        
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        requestRef.current = requestAnimationFrame(gameLoop);
    };

    const handleGameOver = () => {
        state.current.isPlaying = false;
        state.current.isGameOver = true;
        audio.stopEngine();
        
        // Check Highscore
        let newHigh = uiState.highScore;
        const finalScore = Math.floor(state.current.score);
        if (finalScore > uiState.highScore) {
            newHigh = finalScore;
            localStorage.setItem('skyRiderHighScore', newHigh.toString());
        }

        setUiState(prev => ({ 
            ...prev, 
            view: 'GAMEOVER', 
            score: finalScore,
            highScore: newHigh
        }));
    };

    const spawnEntity = (canvasWidth: number, canvasHeight: number) => {
        const r = Math.random();
        let type: Entity['type'] = 'ROCK';
        
        // Weights
        if (r < 0.05) type = 'SHIELD';
        else if (r < 0.08) type = 'MAGNET';
        else if (r < 0.10) type = 'SLOWMO';
        else if (r < 0.30) type = 'COIN';
        else if (r < 0.50) type = 'LASER';
        else if (r < 0.70) type = 'BIRD';
        else type = 'ROCK';

        const entity: Entity = {
            id: Math.random(),
            x: canvasWidth + 50,
            y: 0,
            width: 40,
            height: 40,
            type,
            markedForDeletion: false,
            rotation: 0
        };

        // Specific setups
        if (type === 'COIN') {
            entity.width = 20; entity.height = 20;
            entity.y = Math.random() * (canvasHeight - 100) + 50;
            // Spawn a group?
            state.current.entities.push(entity);
            for(let i=1; i<5; i++) {
                state.current.entities.push({
                    ...entity,
                    id: Math.random(),
                    x: canvasWidth + 50 + (i * 30),
                    y: entity.y + Math.sin(i) * 20 
                });
            }
            return;
        } else if (type === 'LASER') {
            // UPDATED: Horizontal beam instead of full height wall
            entity.width = 200; // Long horizontal
            entity.height = 10; // Thin
            // Spawn at random height
            entity.y = Math.random() * (canvasHeight - 150) + 75;
        } else if (type === 'ROCK') {
            entity.width = 50; entity.height = 50;
            entity.y = Math.random() * (canvasHeight - 150) + 50;
        } else {
            // Birds / Powerups
            entity.width = 30; entity.height = 30;
            entity.y = Math.random() * (canvasHeight - 100) + 50;
        }

        state.current.entities.push(entity);
    };

    const createExplosion = (x: number, y: number, color: string, count = 15) => {
        for(let i=0; i<count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 5 + 2;
            state.current.particles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                color,
                size: Math.random() * 3 + 1
            });
        }
    };

    // --- Main Loop ---
    const gameLoop = (time: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const { width, height } = canvas;
        const s = state.current;

        // 1. UPDATE PHYSICS
        if (s.isPlaying) {
            // Time Dilation (SlowMo)
            let dt = 1;
            if (s.slowMoTime > 0) {
                dt = 0.5;
                s.slowMoTime--;
            }

            // Difficulty
            s.distance += s.speed * dt;
            const difficulty = 1 + Math.floor(s.distance / 2000) * 0.1;
            const effectiveSpeed = (s.speed + difficulty) * dt;

            // Player Physics
            if (s.isThrusting) {
                s.pvy += FLIGHT_POWER;
            }
            s.pvy += GRAVITY;
            // Clamp velocity
            s.pvy = Math.max(Math.min(s.pvy, MAX_SPEED_Y), -MAX_SPEED_Y);
            
            s.py += s.pvy * dt;

            // Audio Modulation
            audio.modulateEngine(s.isThrusting);

            // Bounds
            if (s.py < 0) { s.py = 0; s.pvy = 0; }
            if (s.py > height - s.height - 10) { 
                // Hit ground
                audio.playCrash();
                createExplosion(s.px, s.py, GAME_COLORS.player, 20);
                handleGameOver();
                return; // Stop updating this frame
            }

            // Timers
            if (s.magnetTime > 0) s.magnetTime--;
            if (s.shieldTime > 0) s.shieldTime--;

            // Trail
            if (s.frameCount % 3 === 0) {
                s.trail.push({ x: s.px, y: s.py + s.height/2 });
                if (s.trail.length > 20) s.trail.shift();
            }

            // Spawning
            s.frameCount++;
            if (s.frameCount % Math.floor(SPAWN_RATE / difficulty) === 0) {
                spawnEntity(width, height);
            }

            // Entity Logic
            s.entities.forEach(ent => {
                ent.x -= effectiveSpeed;
                
                // Bird Sine Wave
                if (ent.type === 'BIRD') {
                    ent.y += Math.sin(s.frameCount * 0.1) * 3;
                }
                
                // Magnet
                if (ent.type === 'COIN' && s.magnetTime > 0) {
                    const dx = s.px - ent.x;
                    const dy = s.py - ent.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist < 300) {
                        ent.x += (dx/dist) * 15;
                        ent.y += (dy/dist) * 15;
                    }
                }

                if (ent.x + ent.width < 0) ent.markedForDeletion = true;

                // Collision
                // Simple AABB
                // Shrink hitbox slightly for fairness
                const hitboxPadding = 5;
                if (
                    s.px < ent.x + ent.width - hitboxPadding &&
                    s.px + s.width > ent.x + hitboxPadding &&
                    s.py < ent.y + ent.height - hitboxPadding &&
                    s.py + s.height > ent.y + hitboxPadding
                ) {
                    if (ent.type === 'COIN') {
                        audio.playCoin();
                        s.score += 50;
                        ent.markedForDeletion = true;
                        createExplosion(ent.x, ent.y, GAME_COLORS.coin, 5);
                    } else if (['SHIELD', 'MAGNET', 'SLOWMO'].includes(ent.type)) {
                        audio.playPowerup();
                        if (ent.type === 'SHIELD') s.shieldTime = 600;
                        if (ent.type === 'MAGNET') s.magnetTime = 600;
                        if (ent.type === 'SLOWMO') s.slowMoTime = 300;
                        ent.markedForDeletion = true;
                        createExplosion(ent.x, ent.y, '#fff', 10);
                    } else {
                        // Hazard
                        if (s.shieldTime > 0) {
                            s.shieldTime = 0; // Pop shield
                            ent.markedForDeletion = true;
                            audio.playCrash(); // Softer crash sound ideally
                            createExplosion(ent.x, ent.y, GAME_COLORS.playerShield, 15);
                        } else {
                            audio.playCrash();
                            createExplosion(s.px, s.py, GAME_COLORS.player, 30);
                            handleGameOver();
                        }
                    }
                }
            });

            s.entities = s.entities.filter(e => !e.markedForDeletion);

            // Particles
            s.particles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.life -= 0.02;
                p.vx *= 0.95;
                p.vy *= 0.95;
            });
            s.particles = s.particles.filter(p => p.life > 0);

            // Score Logic
            s.score += 0.1 * dt;
        }

        // 2. RENDER (Draws every frame even if game over, for background)
        ctx.clearRect(0, 0, width, height);

        // -- Background --
        // Deep Space
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, '#020205');
        gradient.addColorStop(1, '#1a0b2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Moving Grid (Cyberpunk floor)
        ctx.save();
        ctx.strokeStyle = 'rgba(176, 38, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Vertical lines moving left
        const gridSpeed = s.isPlaying ? (s.speed * (s.slowMoTime > 0 ? 0.5 : 1)) : 2;
        s.bgOffset = (s.bgOffset - gridSpeed) % 100;
        
        // Horizontal horizon lines
        for(let i=0; i<height/2; i+=40) {
            const y = height - i;
            // Perspective faking
            const yPos = height - (Math.pow(i, 1.2)); 
            if (yPos < height / 2) break;
            ctx.moveTo(0, yPos);
            ctx.lineTo(width, yPos);
        }
        // Vertical lines
        for(let i=0; i<width + 100; i+=100) {
            const x = i + s.bgOffset;
            ctx.moveTo(x, height/2);
            ctx.lineTo(x - 200, height); // Perspective slant
        }
        ctx.stroke();
        ctx.restore();

        // -- Player --
        if (!s.isGameOver) {
            // Trail
            ctx.save();
            ctx.strokeStyle = s.shieldTime > 0 ? GAME_COLORS.playerShield : GAME_COLORS.player;
            ctx.lineWidth = 2;
            ctx.shadowBlur = 10;
            ctx.shadowColor = ctx.strokeStyle;
            ctx.beginPath();
            if (s.trail.length > 0) {
                ctx.moveTo(s.trail[0].x, s.trail[0].y);
                for(let i=1; i<s.trail.length; i++) {
                    ctx.lineTo(s.trail[i].x, s.trail[i].y);
                }
            }
            ctx.stroke();
            ctx.restore();

            // Ship Body
            ctx.save();
            ctx.translate(s.px, s.py);
            // Tilt
            ctx.rotate(Math.min(s.pvy * 0.05, 0.5));
            
            // Glow
            ctx.shadowBlur = 15;
            ctx.shadowColor = s.shieldTime > 0 ? '#fff' : GAME_COLORS.player;
            
            // Triangle shape
            ctx.fillStyle = '#000';
            ctx.strokeStyle = s.shieldTime > 0 ? '#fff' : GAME_COLORS.player;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(s.width, s.height/2); // Nose
            ctx.lineTo(0, s.height);
            ctx.lineTo(5, s.height/2);
            ctx.lineTo(0, 0);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Engine Flare
            if (s.isThrusting) {
                ctx.shadowColor = '#ff9900';
                ctx.fillStyle = '#ffaa00';
                ctx.beginPath();
                ctx.moveTo(0, 5);
                ctx.lineTo(-Math.random() * 20 - 10, s.height/2);
                ctx.lineTo(0, s.height - 5);
                ctx.fill();
            }
            ctx.restore();
        }

        // -- Entities --
        s.entities.forEach(e => {
            ctx.save();
            ctx.translate(e.x, e.y);
            
            ctx.shadowBlur = 10;
            
            if (e.type === 'ROCK') {
                ctx.shadowColor = GAME_COLORS.obstacle;
                ctx.fillStyle = '#2d3436';
                ctx.strokeStyle = GAME_COLORS.obstacle;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(10, 0);
                ctx.lineTo(e.width, 10);
                ctx.lineTo(e.width - 5, e.height);
                ctx.lineTo(0, e.height - 5);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            } else if (e.type === 'LASER') {
                // Horizontal Beam
                ctx.shadowColor = '#ff0000';
                ctx.shadowBlur = 20;
                
                // Core
                ctx.fillStyle = '#ff0000';
                ctx.fillRect(0, 0, e.width, e.height);
                
                // Bright center line
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, e.height/2 - 1, e.width, 2);

                // Emitter ends (visual only)
                ctx.fillStyle = '#333';
                ctx.fillRect(-5, -5, 10, e.height + 10);
                ctx.fillRect(e.width - 5, -5, 10, e.height + 10);
                
            } else if (e.type === 'COIN') {
                ctx.shadowColor = GAME_COLORS.coin;
                ctx.fillStyle = GAME_COLORS.coin;
                ctx.beginPath();
                ctx.arc(e.width/2, e.height/2, e.width/2, 0, Math.PI*2);
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 12px Orbitron';
                ctx.fillText('$', 6, 14);
            } else if (e.type === 'BIRD') {
                 ctx.shadowColor = '#f1c40f';
                 ctx.strokeStyle = '#f1c40f';
                 ctx.lineWidth = 2;
                 ctx.beginPath();
                 ctx.moveTo(0, e.height/2);
                 ctx.lineTo(e.width/2, 0);
                 ctx.lineTo(e.width, e.height/2);
                 ctx.stroke();
            } else {
                // Powerups
                const color = e.type === 'SHIELD' ? GAME_COLORS.playerShield : (e.type === 'MAGNET' ? '#9b59b6' : '#2ecc71');
                ctx.shadowColor = color;
                ctx.strokeStyle = color;
                ctx.fillStyle = 'rgba(255,255,255,0.2)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(e.width/2, e.height/2, e.width/2, 0, Math.PI*2);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#fff';
                ctx.font = '16px Orbitron';
                ctx.fillText(e.type[0], 10, 20);
            }
            ctx.restore();
        });

        // -- Particles --
        s.particles.forEach(p => {
            ctx.save();
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
            ctx.fill();
            ctx.restore();
        });

        // Sync UI occasionally
        if (s.frameCount % 5 === 0 && s.isPlaying) {
            const activePowerups = [];
            if (s.shieldTime > 0) activePowerups.push('SHIELD');
            if (s.magnetTime > 0) activePowerups.push('MAGNET');
            if (s.slowMoTime > 0) activePowerups.push('SLOWMO');
            
            // Only update if different to avoid react thrashing
            if (Math.floor(s.score) !== uiState.score || activePowerups.length !== uiState.powerups.length) {
                setUiState(prev => ({
                    ...prev,
                    score: Math.floor(s.score),
                    powerups: activePowerups
                }));
            }
        }

        requestRef.current = requestAnimationFrame(gameLoop);
    };

    // --- Input Handling ---
    const startInput = () => {
        state.current.isThrusting = true;
    };
    const endInput = () => {
        state.current.isThrusting = false;
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space' || e.code === 'ArrowUp') {
                if (uiState.view === 'START' || uiState.view === 'GAMEOVER') {
                    // Prevent immediate accidental restarts if holding key
                    if (uiState.view === 'START') startGame();
                    if (uiState.view === 'GAMEOVER') startGame();
                } else {
                    startInput();
                }
            }
        };
        const handleKeyUp = () => endInput();

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        
        // Touch/Mouse on global window for gameplay
        const handleDown = (e: Event) => {
            // If clicking a button, let the button handle it
            if ((e.target as HTMLElement).tagName === 'BUTTON') return;

            // Global click start
            if (uiState.view === 'START' || uiState.view === 'GAMEOVER') {
                startGame();
            } else {
                startInput();
            }
        };

        const handleUp = () => endInput();
        
        window.addEventListener('mousedown', handleDown);
        window.addEventListener('mouseup', handleUp);
        window.addEventListener('touchstart', handleDown);
        window.addEventListener('touchend', handleUp);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('mousedown', handleDown);
            window.removeEventListener('mouseup', handleUp);
            window.removeEventListener('touchstart', handleDown);
            window.removeEventListener('touchend', handleUp);
        };
    }, [uiState.view]); // Re-bind if view changes to allow space to start

    // Resize
    useEffect(() => {
        const r = () => {
            if (canvasRef.current) {
                canvasRef.current.width = window.innerWidth;
                canvasRef.current.height = window.innerHeight;
            }
        };
        window.addEventListener('resize', r);
        r();
        return () => window.removeEventListener('resize', r);
    }, []);

    // Initial loop just for background
    useEffect(() => {
        requestRef.current = requestAnimationFrame(gameLoop);
        return () => cancelAnimationFrame(requestRef.current);
    }, []);

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
            <canvas ref={canvasRef} />
            
            {/* UI Layer */}
            <div style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                pointerEvents: 'none' // Important: Lets clicks pass through to canvas inputs
            }}>
                
                {/* HUD */}
                {uiState.view === 'PLAYING' && (
                    <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                            <div style={{ fontSize: '32px', color: GAME_COLORS.text, fontWeight: 'bold', textShadow: `0 0 10px ${GAME_COLORS.text}` }}>
                                {uiState.score}
                            </div>
                            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px' }}>HI: {uiState.highScore}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            {uiState.powerups.map((p, i) => (
                                <div key={i} style={{
                                    width: '40px', height: '40px', borderRadius: '50%',
                                    background: p === 'SHIELD' ? GAME_COLORS.playerShield : (p === 'MAGNET' ? '#9b59b6' : '#2ecc71'),
                                    color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontWeight: 'bold', boxShadow: `0 0 15px ${p === 'SHIELD' ? '#fff' : '#fff'}`
                                }}>
                                    {p[0]}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Main Menu */}
                {uiState.view === 'START' && (
                    <div style={{
                        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                        textAlign: 'center', pointerEvents: 'auto'
                    }}>
                        <h1 style={{ 
                            fontSize: '4rem', color: GAME_COLORS.player, margin: 0,
                            textShadow: '0 0 20px #00f3ff, 2px 2px 0px #b026ff', letterSpacing: '5px'
                        }}>
                            SKY RIDER
                        </h1>
                        <p style={{ color: '#fff', letterSpacing: '2px', margin: '20px 0 40px' }}>
                            NEON EDITION
                        </p>
                        <button 
                            onClick={startGame}
                            style={{
                                background: 'transparent', border: `2px solid ${GAME_COLORS.player}`,
                                color: GAME_COLORS.player, padding: '15px 50px', fontSize: '1.2rem',
                                borderRadius: '5px', cursor: 'pointer', fontFamily: 'Orbitron',
                                boxShadow: `0 0 10px ${GAME_COLORS.player}, inset 0 0 10px ${GAME_COLORS.player}`,
                                textTransform: 'uppercase', transition: 'all 0.2s'
                            }}
                            onMouseOver={e => {
                                e.currentTarget.style.background = GAME_COLORS.player;
                                e.currentTarget.style.color = '#000';
                            }}
                            onMouseOut={e => {
                                e.currentTarget.style.background = 'transparent';
                                e.currentTarget.style.color = GAME_COLORS.player;
                            }}
                        >
                            INITIATE FLIGHT
                        </button>
                    </div>
                )}

                {/* Game Over */}
                {uiState.view === 'GAMEOVER' && (
                    <div style={{
                        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                        textAlign: 'center', pointerEvents: 'auto',
                        background: 'rgba(0,0,0,0.85)', padding: '40px 60px', borderRadius: '10px',
                        border: `1px solid ${GAME_COLORS.obstacle}`,
                        boxShadow: `0 0 30px rgba(255, 42, 109, 0.3)`
                    }}>
                        <h2 style={{ color: GAME_COLORS.obstacle, fontSize: '3rem', margin: '0 0 20px' }}>CRASHED</h2>
                        <div style={{ fontSize: '2rem', color: '#fff', marginBottom: '10px' }}>{uiState.score}</div>
                        <div style={{ color: '#aaa', marginBottom: '30px' }}>BEST: {uiState.highScore}</div>
                        
                        <button 
                            onClick={startGame}
                            style={{
                                background: GAME_COLORS.obstacle, border: 'none',
                                color: '#fff', padding: '15px 40px', fontSize: '1.2rem',
                                borderRadius: '30px', cursor: 'pointer', fontFamily: 'Orbitron',
                                boxShadow: `0 0 20px ${GAME_COLORS.obstacle}`,
                                fontWeight: 'bold', textTransform: 'uppercase'
                            }}
                        >
                            RETRY
                        </button>
                    </div>
                )}
            </div>

            {/* Tap Hint */}
            {uiState.view === 'PLAYING' && (
                <div style={{
                    position: 'absolute', bottom: '30px', width: '100%', textAlign: 'center',
                    color: 'rgba(255,255,255,0.2)', fontSize: '12px', pointerEvents: 'none'
                }}>
                    HOLD TO ASCEND /// RELEASE TO DESCEND
                </div>
            )}
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<SkyRider />);
