# Reasoning Model Training Guide

This guide covers the key ideas behind training modern reasoning models end to end.

## Reinforcement Learning

Reinforcement learning (RL) turns model outputs into signals. The classic
recipe combines a policy, a reward model, and a search procedure. Modern
deepseek-style models scale this pipeline to thousands of GPUs.

## Preferences and Alignment

Humans prefer some answers over others. Offline preference ranking builds a
reward model from pairwise comparisons, while online methods sample from the
current policy and score responses with reference models. Both are combined
with a KL-regularized objective to stay close to the supervised policy.

## On-Policy vs Off-Policy

On-policy methods use data sampled from the current policy; off-policy methods
reuse older experience. In controlled environments, small policy changes make
the difference between stable training and divergence.

## Practical Checklist

- Set learning-rate warmup before the RL stage.
- Clip importance ratios to avoid catastrophic updates.
- Monitor reward hacking with a held-out judge set.
- Save the best checkpoint by reward, not by token count.
