---
library_name: peft
license: other
base_model: C:/AI/models/Qwen3-4B-Instruct-2507
tags:
- base_model:adapter:C:/AI/models/Qwen3-4B-Instruct-2507
- llama-factory
- lora
- transformers
pipeline_tag: text-generation
model-index:
- name: customer-service-smoke
  results: []
---

<!-- This model card has been generated automatically according to the information the Trainer had access to. You
should probably proofread and complete it, then remove this comment. -->

# customer-service-smoke

This model is a fine-tuned version of [C:/AI/models/Qwen3-4B-Instruct-2507](https://huggingface.co/C:/AI/models/Qwen3-4B-Instruct-2507) on the customer_service_smoke_20 dataset.

## Model description

More information needed

## Intended uses & limitations

More information needed

## Training and evaluation data

More information needed

## Training procedure

### Training hyperparameters

The following hyperparameters were used during training:
- learning_rate: 0.0001
- train_batch_size: 1
- eval_batch_size: 8
- seed: 42
- gradient_accumulation_steps: 4
- total_train_batch_size: 4
- optimizer: Use OptimizerNames.ADAMW_TORCH_FUSED with betas=(0.9,0.999) and epsilon=1e-08 and optimizer_args=No additional optimizer arguments
- lr_scheduler_type: cosine
- lr_scheduler_warmup_ratio: 0.1
- num_epochs: 2.0

### Training results



### Framework versions

- PEFT 0.18.1
- Transformers 4.56.2
- Pytorch 2.9.1+cu128
- Datasets 4.0.0
- Tokenizers 0.22.2