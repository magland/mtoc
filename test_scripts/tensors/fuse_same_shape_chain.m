% Exercises the same-shape elementwise fusion peephole
% (src/codegen/opt/fuseSameShape.ts). A 3-stmt chain of single-use
% elementwise Assigns over identically-shaped tensors should collapse
% to one fused loop in the generated C; the printed result must remain
% byte-for-byte identical to numbl's interpretation.

a = ones(3, 4) * 2.5;
b = a + 1;
d = b * 0.5;
e = d - 0.25;
disp(e);

% A negative case: b' is used twice (consumer + disp), so the producer
% must NOT be fused. We still print the values to confirm.
x = ones(2, 5);
y = x + 7;
z = y * 3;
disp(y);
disp(z);
