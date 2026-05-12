% Exercises the column/row-slice inlining peephole
% (src/codegen/opt/inlineColumnSlice.ts). The compiled program must
% remain byte-for-byte identical to numbl's interpretation; correctness
% of the index math is what's checked here.

M = zeros(4, 5);
for i = 1:4
    for j = 1:5
        M(i, j) = i * 10 + j;
    end
end

% Column slice into a broadcast consumer (row + col → matrix).
col1 = M(:, 1);
row1 = M(1, :);
sum_mat = col1 + row1;
disp(sum_mat);

% Column slice into a flat-iter consumer (same-shape elementwise).
a = M(:, 2);
b = M(:, 3);
diff_col = a - b;
disp(diff_col);

% Row slice with a non-1 fixed index (exercises the (k-1) offset).
r2 = M(2, :);
r3 = M(3, :);
sum_row = r2 + r3;
disp(sum_row);
